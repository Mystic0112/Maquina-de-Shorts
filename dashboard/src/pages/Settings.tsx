import {
  BadgeCheck,
  Music,
  Captions,
  CircleCheck,
  Shapes,
  CircleX,
  Clapperboard,
  FileText,
  Film,
  KeyRound,
  Layers,
  LoaderCircle,
  Megaphone,
  Mic,
  Palette,
  Play,
  Plus,
  Ruler,
  Save,
  Scissors,
  Search,
  Sparkles,
  Trash2,
  TriangleAlert,
  Type,
  Undo2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type {
  CaptionSettings,
  CutChannelDraft,
  CutsPayload,
  FieldError,
  RunSummary,
  SaveResponse,
  SettingsPayload,
  TopicCategory,
  TopicsPayload,
  VisualSettings,
  VoiceInfo,
  VoiceSampleResponse,
} from "../../shared/api";
import { categoryColor } from "../colors";
import { Card, Empty, formatIcon } from "../components";
import { CutsChannelsSection } from "../CutsChannels";
import { MusicSection } from "../MusicSection";
import { WatermarkSection } from "../WatermarkSection";
import { SCRIPT_FORMATS, type ScriptFormat } from "../format";
import { PreviewPanel } from "../PreviewPanel";
import {
  clone,
  formatDelta,
  getPath,
  parseDelta,
  same,
  schemaAt,
  setPath,
  slugify,
  validateSettings,
  validateTopics,
  type Json,
} from "../settingsModel";
import { ChipMultiSelect, ColorField, Field, NumberInput, Section, Segmented, Slider, Switch, TextInput } from "../settingsUi";

const SECTIONS = [
  { id: "cfg-cortes", label: "Canais de corte", icon: Scissors },
  { id: "cfg-voz", label: "Voz", icon: Mic },
  { id: "cfg-legendas", label: "Legendas", icon: Captions },
  { id: "cfg-visual", label: "Visual", icon: Palette },
  { id: "cfg-roteiro", label: "Roteiro", icon: FileText },
  { id: "cfg-formato", label: "Formato", icon: Ruler },
  { id: "cfg-marca", label: "Marca", icon: BadgeCheck },
  { id: "cfg-musica", label: "Músicas", icon: Music },
  { id: "cfg-temas", label: "Temas", icon: Layers },
  { id: "cfg-upload", label: "Upload", icon: Upload },
  { id: "cfg-chaves", label: "Chaves", icon: KeyRound },
] as const;

const FONT_LABELS: Record<string, string> = {
  "arial-black": "Arial Black",
  impact: "Impact",
  "segoe-black": "Segoe UI Black",
  verdana: "Verdana",
};
const LOCALES = [
  { id: "pt-BR", label: "Português (BR)" },
  { id: "pt-PT", label: "Português (PT)" },
  { id: "es", label: "Espanhol" },
  { id: "en", label: "Inglês" },
];
const HIGHLIGHT_HELP: Record<Required<CaptionSettings>["highlight"], string> = {
  keywords: "Só as palavras importantes acendem (substantivos, números, verbos fortes); artigos e preposições ficam na cor do texto.",
  color: "Cada palavra acende no momento em que é narrada.",
  none: "Todas as palavras ficam na cor do texto.",
};
const FORMAT_OPTIONS = SCRIPT_FORMATS.map((f) => ({ value: f.id as ScriptFormat, label: f.label, hint: f.hint, icon: formatIcon(f.id) }));
/** 0.15 -> "0,15 s" */
const fmtSeconds = (v: number, digits = 2): string => `${v.toLocaleString("pt-BR", { maximumFractionDigits: digits })} s`;
const DEFAULT_SAMPLE = "Você sabia que um dia em Vênus dura mais do que um ano inteiro? Segue o canal para mais curiosidades!";
const FPS_FALLBACK = 30;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function putJson(url: string, body: unknown, version: string): Promise<SaveResponse> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "If-Match": version },
    body: JSON.stringify(body),
  });
  return (await res.json()) as SaveResponse;
}

/** Strips undefined so resolved = defaults overlaid with whatever the draft sets. */
function overlay<T extends object>(defaults: T, section: unknown): T {
  const set = Object.fromEntries(Object.entries((section ?? {}) as object).filter(([, v]) => v !== undefined));
  return { ...defaults, ...set } as T;
}

export function Settings({ runs }: { runs: RunSummary[] }) {
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [topics, setTopics] = useState<TopicsPayload | null>(null);
  const [draft, setDraft] = useState<Json | null>(null);
  const [topicsDraft, setTopicsDraft] = useState<TopicCategory[] | null>(null);
  const [cuts, setCuts] = useState<CutsPayload | null>(null);
  const [cutsDraft, setCutsDraft] = useState<CutChannelDraft[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "good" | "bad"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, t, c] = await Promise.all([getJson<SettingsPayload>("/api/settings"), getJson<TopicsPayload>("/api/topics"), getJson<CutsPayload>("/api/cuts")]);
      setSettings(s);
      setTopics(t);
      setCuts(c);
      setDraft(clone(s.config));
      setTopicsDraft(clone(t.data.categories ?? []));
      setCutsDraft(clone(c.data.channels ?? []));
      setServerErrors([]);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => void load(), [load]);

  useEffect(() => {
    if (notice?.tone !== "good") return;
    const t = setTimeout(() => setNotice(null), 12_000);
    return () => clearTimeout(t);
  }, [notice]);

  const settingsDirty =!!settings && !!draft && !same(settings.config, draft);
  const topicsDirty = !!topics && !!topicsDraft && !same(topics.data.categories, topicsDraft);
  const cutsDirty = !!cuts && !!cutsDraft && !same(cuts.data.channels, cutsDraft);
  const dirty = settingsDirty || topicsDirty || cutsDirty;

  // Files can change outside the page (pipeline agent, git): refresh on focus while there are no edits.
  useEffect(() => {
    if (dirty) return;
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [dirty, load]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const clientErrors = useMemo(
    () => [...(settings && draft ? validateSettings(settings.schema, draft) : []), ...(topicsDraft ? validateTopics(topicsDraft) : [])],
    [settings, draft, topicsDraft],
  );
  const errorAt = (path: string): string | undefined =>
    clientErrors.find((e) => e.path === path)?.message ?? serverErrors.find((e) => e.path === path)?.message;

  if (loadError) {
    return (
      <Card>
        <Empty icon={TriangleAlert} title="Não foi possível carregar as configurações">
          {loadError}
        </Empty>
      </Card>
    );
  }
  if (!settings || !draft || !topics || !topicsDraft || !cuts || !cutsDraft) {
    return (
      <Card>
        <Empty icon={LoaderCircle} title="Carregando configurações…" />
      </Card>
    );
  }

  const set = (path: string, value: unknown) => {
    setDraft((d) => setPath(d, path, value));
    setNotice(null);
  };
  const range = (path: string, fallback: [number, number]): [number, number] => {
    const node = schemaAt(settings.schema, path);
    return [node?.minimum ?? fallback[0], node?.maximum ?? fallback[1]];
  };

  const captions = overlay(settings.defaults.captions, draft.captions) as Required<CaptionSettings>;
  const visual = overlay(settings.defaults.visual, draft.visual) as Required<VisualSettings>;
  const script = overlay(settings.defaults.script, draft.script);
  const watermark = overlay(settings.defaults.watermark, draft.watermark);
  const voice = (draft.voice ?? {}) as VoiceDraft;
  const fps = (getPath(draft, "video.fps") as number | undefined) ?? FPS_FALLBACK;
  const styleInvalid = clientErrors.some((e) => e.path.startsWith("captions") || e.path.startsWith("visual"));

  const save = async () => {
    setSaving(true);
    setNotice(null);
    try {
      const results: SaveResponse[] = [];
      if (settingsDirty) results.push(await putJson("/api/settings", draft, settings.version));
      if (topicsDirty) results.push(await putJson("/api/topics", { ...topics.data, categories: topicsDraft }, topics.version));
      if (cutsDirty) {
        const r = await putJson("/api/cuts", { ...cuts.data, channels: cutsDraft }, cuts.version);
        results.push({ ...r, errors: r.errors?.map((e) => ({ ...e, path: `cuts.${e.path}` })) });
      }
      const failed = results.find((r) => !r.ok);
      if (failed) {
        setServerErrors(results.flatMap((r) => r.errors ?? []));
        setNotice({ tone: "bad", text: failed.message });
        return;
      }
      const backups = results.map((r) => r.backup).filter(Boolean);
      await load();
      setNotice({ tone: "good", text: `Salvo. Backup da versão anterior: config/backups/${backups.join(", ")}` });
    } catch (e) {
      setNotice({ tone: "bad", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setDraft(clone(settings.config));
    setTopicsDraft(clone(topics.data.categories));
    setCutsDraft(clone(cuts.data.channels));
    setServerErrors([]);
    setNotice(null);
  };

  return (
    <>
      <nav className="cfg-nav" aria-label="Seções">
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" className="ghost" onClick={() => document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
            <s.icon size={14} /> {s.label}
          </button>
        ))}
      </nav>
      {!settings.valid && (
        <div className="banner">
          <TriangleAlert size={16} color="var(--critical)" /> O arquivo config/pipeline.config.json atual tem campos inválidos. Corrija-os abaixo antes de salvar.
        </div>
      )}

      <div className="cfg-layout">
        <div className="cfg-main">
          {/* First: the owner looks for the channel links here most (2026-10-22). */}
          <CutsChannelsSection channels={cutsDraft} fileExists={cuts.exists} onChange={setCutsDraft} errorAt={errorAt} />

          <VoiceSection voice={voice} set={set} errorAt={errorAt} defaults={settings.defaults.voice} />

          <Section
            id="cfg-legendas"
            icon={Captions}
            title="Legendas"
            description="Como as palavras aparecem na tela, sincronizadas com a narração."
            onReset={() => set("captions", undefined)}
          >
            <div className="cfg-grid">
              <Switch label="Mostrar legendas" checked={captions.enabled} onChange={(v) => set("captions.enabled", v)} />
              <Switch label="Tudo em maiúsculas" checked={captions.uppercase} onChange={(v) => set("captions.uppercase", v)} />
              <Segmented
                label="Palavras por legenda"
                value={captions.maxWordsPerCue}
                options={[1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }))}
                onChange={(v) => set("captions.maxWordsPerCue", v)}
                help="Menos palavras = leitura mais rápida e dinâmica."
                error={errorAt("captions.maxWordsPerCue")}
              />
              <Field label="Fonte" error={errorAt("captions.font")}>
                <div className="font-picker">
                  {Object.entries(settings.fonts).map(([id, stack]) => (
                    <button key={id} type="button" className={captions.font === id ? "on" : ""} style={{ fontFamily: stack }} onClick={() => set("captions.font", id)}>
                      {FONT_LABELS[id] ?? id}
                    </button>
                  ))}
                </div>
              </Field>
              <Slider
                label="Tamanho máximo do texto"
                value={captions.maxFontPx}
                min={range("captions.maxFontPx", [48, 140])[0]}
                max={range("captions.maxFontPx", [48, 140])[1]}
                format={(v) => `${v} px`}
                onChange={(v) => set("captions.maxFontPx", v)}
                help="Em pixels no vídeo 1080×1920; palavras longas encolhem para caber."
                error={errorAt("captions.maxFontPx")}
              />
              <Slider
                label="Posição vertical"
                value={captions.verticalPosition}
                min={range("captions.verticalPosition", [0.3, 0.75])[0]}
                max={range("captions.verticalPosition", [0.3, 0.75])[1]}
                step={0.01}
                format={(v) => `${Math.round(v * 100)}% da altura`}
                onChange={(v) => set("captions.verticalPosition", v)}
                help="Os ~20% de baixo ficam cobertos pela interface do Shorts (veja a zona segura na prévia)."
                error={errorAt("captions.verticalPosition")}
              />
              <ColorField label="Cor do texto" value={captions.textColor} presets="text" onChange={(v) => set("captions.textColor", v)} error={errorAt("captions.textColor")} />
              <ColorField label="Cor do contorno" value={captions.strokeColor} presets="stroke" onChange={(v) => set("captions.strokeColor", v)} error={errorAt("captions.strokeColor")} />
              <Segmented
                label="Destaque das palavras"
                value={captions.highlight}
                options={[
                  { value: "keywords", label: "Importantes" },
                  { value: "color", label: "Todas" },
                  { value: "none", label: "Nenhuma" },
                ]}
                onChange={(v) => set("captions.highlight", v)}
                help={HIGHLIGHT_HELP[captions.highlight]}
                error={errorAt("captions.highlight")}
              />
              {captions.highlight !== "none" && (
                <ColorField label="Cor do destaque" value={captions.highlightColor} presets="highlight" onChange={(v) => set("captions.highlightColor", v)} error={errorAt("captions.highlightColor")} />
              )}
              <Switch
                label="Não terminar legenda em “de”, “da”, “com”…"
                checked={captions.avoidDanglingWords}
                onChange={(v) => set("captions.avoidDanglingWords", v)}
                help="Evita quebras como “O CHEIRO DA” / “LUA”: artigos e preposições passam para a legenda seguinte."
              />
            </div>
          </Section>

          <Section id="cfg-visual" icon={Palette} title="Visual" description="Movimento das imagens, transições e legibilidade." onReset={() => set("visual", undefined)}>
            <div className="cfg-grid">
              <Slider
                label="Zoom nas imagens"
                value={visual.imageZoom}
                min={range("visual.imageZoom", [1, 1.25])[0]}
                max={range("visual.imageZoom", [1, 1.25])[1]}
                step={0.01}
                format={(v) => `${Math.round((v - 1) * 100)}%`}
                onChange={(v) => set("visual.imageZoom", v)}
                help="Efeito Ken Burns nas fotos (0% = imagem parada)."
                error={errorAt("visual.imageZoom")}
              />
              <Slider
                label="Zoom nos vídeos"
                value={visual.videoZoom}
                min={range("visual.videoZoom", [1, 1.2])[0]}
                max={range("visual.videoZoom", [1, 1.2])[1]}
                step={0.01}
                format={(v) => `${Math.round((v - 1) * 100)}%`}
                onChange={(v) => set("visual.videoZoom", v)}
                help="Aproximação lenta nos clipes de vídeo."
                error={errorAt("visual.videoZoom")}
              />
              <Slider
                label="Transição entre cenas"
                value={visual.crossfadeFrames}
                min={range("visual.crossfadeFrames", [0, 20])[0]}
                max={range("visual.crossfadeFrames", [0, 20])[1]}
                format={(v) => (v === 0 ? "corte seco" : `${v} quadros · ${Math.round((v / fps) * 1000)} ms`)}
                onChange={(v) => set("visual.crossfadeFrames", v)}
                error={errorAt("visual.crossfadeFrames")}
              />
              <Switch label="Movimento lateral nas imagens" checked={visual.imagePan} onChange={(v) => set("visual.imagePan", v)} help="Além do zoom, desliza a foto suavemente (só nas fotos com rosto, quando 'Zoom só em rostos' está ligado)." />
              <Switch
                label="Zoom só em rostos"
                checked={visual.zoomOnlyOnFaces}
                onChange={(v) => set("visual.zoomOnlyOnFaces", v)}
                help="Aproxima só quando a imagem mostra um rosto; objetos e cenários ficam totalmente parados."
              />
              <Switch
                label="Faixa escura atrás das legendas"
                checked={visual.captionBackdrop}
                onChange={(v) => set("visual.captionBackdrop", v)}
                help="Gradiente que melhora a leitura em fundos claros."
              />

              <div className="subsection">
                <Film size={13} /> Ritmo e movimento
              </div>
              <Slider
                label="Tempo máximo de cada enquadramento"
                value={visual.maxShotSeconds}
                min={range("visual.maxShotSeconds", [2, 12])[0]}
                max={range("visual.maxShotSeconds", [2, 12])[1]}
                step={0.5}
                format={(v) => fmtSeconds(v, 1)}
                onChange={(v) => set("visual.maxShotSeconds", v)}
                help="Vale para vídeos: um clipe longo corta para outro trecho dele a cada tanto. Imagens nunca se repetem, então cada uma fica na tela o tempo da cena dividido entre as imagens."
                error={errorAt("visual.maxShotSeconds")}
              />
              <Segmented
                label="Curva do movimento"
                value={visual.motionEasing}
                options={[
                  { value: "ease", label: "Suave" },
                  { value: "linear", label: "Linear" },
                ]}
                onChange={(v) => set("visual.motionEasing", v)}
                help={visual.motionEasing === "ease" ? "Zoom e deslize aceleram e freiam devagar, como uma câmera de verdade." : "Velocidade constante do início ao fim de cada plano."}
                error={errorAt("visual.motionEasing")}
              />
              <Switch
                label="Zoom rápido na abertura"
                checked={visual.openingPunchIn}
                onChange={(v) => set("visual.openingPunchIn", v)}
                help="Aproximação mais forte no primeiro plano para segurar quem está rolando o feed."
              />
              <Slider
                label="Sobra no final"
                value={visual.tailSeconds}
                min={range("visual.tailSeconds", [0, 1.5])[0]}
                max={range("visual.tailSeconds", [0, 1.5])[1]}
                step={0.05}
                format={(v) => (v === 0 ? "sem sobra" : fmtSeconds(v))}
                onChange={(v) => set("visual.tailSeconds", v)}
                help="Tempo de vídeo depois da última palavra. Sobra curta faz o Short emendar melhor no replay."
                error={errorAt("visual.tailSeconds")}
              />

              <div className="subsection">
                <Type size={13} /> Texto de capa
              </div>
              <Switch
                label="Texto de capa no início"
                checked={visual.overlayHook}
                onChange={(v) => set("visual.overlayHook", v)}
                help="Mostra a frase-gancho do roteiro (ex.: “A LUA TEM CHEIRO?”) no alto da tela nos primeiros segundos; o primeiro quadro vira a capa do vídeo."
              />
              {visual.overlayHook && (
                <Slider
                  label="Duração do texto de capa"
                  value={visual.overlayHookSeconds}
                  min={range("visual.overlayHookSeconds", [1, 5])[0]}
                  max={range("visual.overlayHookSeconds", [1, 5])[1]}
                  step={0.5}
                  format={(v) => fmtSeconds(v, 1)}
                  onChange={(v) => set("visual.overlayHookSeconds", v)}
                  help="Some com um esmaecimento curto no fim desse tempo."
                  error={errorAt("visual.overlayHookSeconds")}
                />
              )}
            </div>
          </Section>

          <Section id="cfg-roteiro" icon={FileText} title="Roteiro" description="Tamanho e tom dos textos que o Gemini escreve." onReset={() => set("script", undefined)}>
            <div className="cfg-grid">
              <NumberInput label="Mínimo de palavras" value={script.minWords} {...bounds(settings.schema, "script.minWords")} onChange={(v) => set("script.minWords", v)} error={errorAt("script.minWords")} />
              <NumberInput
                label="Máximo de palavras"
                value={script.maxWords}
                {...bounds(settings.schema, "script.maxWords")}
                onChange={(v) => set("script.maxWords", v)}
                help={`≈ ${Math.round(script.minWords / 2.6)}–${Math.round(script.maxWords / 2.6)} s de narração`}
                error={errorAt("script.maxWords")}
              />
              <NumberInput label="Mínimo de cenas" value={script.minScenes} {...bounds(settings.schema, "script.minScenes")} onChange={(v) => set("script.minScenes", v)} error={errorAt("script.minScenes")} />
              <NumberInput label="Máximo de cenas" value={script.maxScenes} {...bounds(settings.schema, "script.maxScenes")} onChange={(v) => set("script.maxScenes", v)} error={errorAt("script.maxScenes")} />
              <Segmented
                label="Tom"
                value={script.tone}
                options={[
                  { value: "curioso", label: "Curioso" },
                  { value: "empolgado", label: "Empolgado" },
                  { value: "misterioso", label: "Misterioso" },
                  { value: "didatico", label: "Didático" },
                ]}
                onChange={(v) => set("script.tone", v)}
                error={errorAt("script.tone")}
              />
              <Switch
                label="Checagem de fatos antes de produzir"
                checked={script.factCheck !== false}
                onChange={(v) => set("script.factCheck", v)}
                help="O Gemini confere cada afirmação com busca no Google e corrige o roteiro (≈ 4–6 chamadas extras por vídeo). Roteiros que não puderem ser corrigidos são descartados e refeitos com outro tema."
              />
              <Switch
                label="Final que volta ao gancho"
                checked={script.loopEnding}
                onChange={(v) => set("script.loopEnding", v)}
                help="A última frase responde ou retoma a pergunta do início, para o vídeo emendar no replay em vez de terminar numa despedida genérica."
              />
              <Switch
                label="Buscar imagens específicas"
                checked={script.specificFootage}
                onChange={(v) => set("script.specificFootage", v)}
                help="Lugares, missões, obras e personagens históricos (ex.: “Apollo 11”, “Coliseu”), além das imagens genéricas."
              />

              <div className="subsection">
                <FileText size={13} /> Instruções do dono
              </div>
              <Field
                label="Regras fixas para o roteiro"
                wide
                help={`Texto livre que entra no prompt de TODO roteiro, abaixo das regras da Máquina (fatos, tamanho, cenas, formato e imagens sempre vencem). Ex.: “Sempre termine com uma pergunta para o público.” ${(script.instructions ?? "").length}/1000`}
                error={errorAt("script.instructions")}
              >
                <textarea
                  className="input"
                  rows={4}
                  maxLength={1000}
                  value={script.instructions ?? ""}
                  placeholder="Uma regra por linha. Ex.: Comece com um número impressionante. Use linguagem de quem conversa com um amigo."
                  onChange={(e) => set("script.instructions", e.target.value)}
                  aria-label="Instruções para o roteirista"
                />
              </Field>

              <div className="subsection">
                <Megaphone size={13} /> Chamada final
              </div>
              <Segmented
                label="Estilo da chamada"
                value={script.ctaStyle}
                options={[
                  { value: "curto", label: "Curta" },
                  { value: "nenhum", label: "Nenhuma" },
                ]}
                onChange={(v) => set("script.ctaStyle", v)}
                help={
                  script.cta?.trim()
                    ? "Sem efeito agora: a chamada fixa tem prioridade."
                    : script.ctaStyle === "curto"
                      ? "O modelo escreve uma chamada curta e variada, sem nunca usar a palavra “canal”."
                      : "O vídeo termina sem pedir like, inscrição ou comentário."
                }
                error={errorAt("script.ctaStyle")}
              />
              <TextInput
                label="Chamada final fixa (opcional)"
                value={script.cta ?? ""}
                maxLength={120}
                placeholder="Ex.: Comenta o que te surpreendeu!"
                onChange={(v) => set("script.cta", v.trim() ? v : undefined)}
                help="Preenchida, substitui o estilo da chamada em todos os vídeos. Vazio = segue o estilo."
                error={errorAt("script.cta")}
              />

              <div className="subsection">
                <Shapes size={13} /> Formatos
              </div>
              <ChipMultiSelect
                label="Formatos que o pipeline sorteia"
                value={script.formats}
                options={FORMAT_OPTIONS}
                min={1}
                onChange={(v) => set("script.formats", v)}
                help={`${script.formats.length} de ${FORMAT_OPTIONS.length} ativos. A etapa 01 alterna entre eles para vídeos seguidos não repetirem a mesma estrutura.`}
                error={errorAt("script.formats") ?? clientErrors.find((e) => e.path.startsWith("script.formats."))?.message}
              />
            </div>
          </Section>

          <Section
            id="cfg-formato"
            icon={Ruler}
            title="Formato e duração"
            description="Limites de duração do vídeo final."
            onReset={() => {
              set("video.minSeconds", 45);
              set("video.maxSeconds", 90);
            }}
          >
            <div className="cfg-grid">
              <NumberInput label="Duração mínima" suffix="s" value={getPath(draft, "video.minSeconds") as number | undefined} onChange={(v) => set("video.minSeconds", v)} error={errorAt("video.minSeconds")} />
              <NumberInput
                label="Duração máxima"
                suffix="s"
                value={getPath(draft, "video.maxSeconds") as number | undefined}
                onChange={(v) => set("video.maxSeconds", v)}
                help="Shorts aceitam até 3 minutos; 45–90 s costuma reter melhor."
                error={errorAt("video.maxSeconds")}
              />
            </div>
            <div className="readonly-tiles">
              <div>
                <span>Resolução</span>
                <b>
                  {String(getPath(draft, "video.width") ?? 1080)}×{String(getPath(draft, "video.height") ?? 1920)}
                </b>
              </div>
              <div>
                <span>Quadros por segundo</span>
                <b>{fps} fps</b>
              </div>
              <p className="hint">Fixos: o YouTube Shorts é vertical 9:16, e 1080×1920 é o tamanho nativo do formato.</p>
            </div>
          </Section>

          <WatermarkSection wm={watermark} set={set} errorAt={errorAt} />

          <MusicSection />

          <TopicsSection categories={topicsDraft} originalIds={new Set(topics.data.categories.map((c) => c.id))} onChange={setTopicsDraft} errorAt={errorAt} />


          <Section
            id="cfg-upload"
            icon={Upload}
            title="Upload"
            description="Como e quando os vídeos são publicados no seu canal (etapa 08)."
            onReset={() => {
              set("upload.privacyStatus", "unlisted");
              set("upload.maxUploadsPerDay", 3);
              set("upload.enabled", undefined);
              set("upload.containsSyntheticMedia", undefined);
            }}
          >
            <div className="cfg-grid">
              <Switch
                label="Publicar automaticamente no YouTube"
                checked={getPath(draft, "upload.enabled") === true}
                onChange={(v) => {
                  if (
                    v &&
                    !window.confirm(
                      "Ligar o upload automático?\n\nA partir da próxima execução do pipeline, cada vídeo aprovado será ENVIADO AO SEU CANAL DO YOUTUBE sem revisão manual, com a visibilidade escolhida abaixo e respeitando o limite diário.",
                    )
                  ) {
                    return;
                  }
                  set("upload.enabled", v);
                }}
                help={
                  getPath(draft, "upload.enabled") === true
                    ? "Ligado: os vídeos vão para o canal sozinhos."
                    : "Desligado: os vídeos ficam só no disco (etapa 08 é pulada)."
                }
              />
              <Switch
                label="Declarar conteúdo sintético (IA)"
                checked={getPath(draft, "upload.containsSyntheticMedia") === true}
                onChange={(v) => set("upload.containsSyntheticMedia", v)}
                help="Marca o aviso “conteúdo alterado ou sintético” do YouTube. Exigido quando o vídeo mostra pessoas, lugares ou eventos realistas que não existiram; narração com voz sintética sobre imagens reais normalmente não exige."
              />
              <Segmented
                label="Visibilidade ao publicar"
                value={(getPath(draft, "upload.privacyStatus") as string) ?? "unlisted"}
                options={[
                  { value: "private", label: "Privado" },
                  { value: "unlisted", label: "Não listado" },
                  { value: "public", label: "Público" },
                ]}
                onChange={(v) => set("upload.privacyStatus", v)}
                help="Projetos de API não verificados pelo Google publicam como privado, seja qual for a escolha."
                error={errorAt("upload.privacyStatus")}
              />
              <NumberInput
                label="Máximo de uploads por dia"
                value={getPath(draft, "upload.maxUploadsPerDay") as number | undefined}
                min={0}
                onChange={(v) => set("upload.maxUploadsPerDay", v)}
                help="A cota padrão da API do YouTube permite cerca de 6 uploads por dia."
                error={errorAt("upload.maxUploadsPerDay")}
              />
            </div>
          </Section>

          <Section
            id="cfg-edicao"
            icon={Sparkles}
            title="Edição (memes e efeitos)"
            description="Figurinhas e sons curtos da biblioteca assets/memes/ encaixados na fala (etapa 05b). Só entram arquivos com licença aprovada; créditos CC BY vão para a descrição."
            onReset={() => set("editing", undefined)}
          >
            <div className="cfg-grid">
              <Switch
                label="Ligar memes e efeitos"
                checked={getPath(draft, "editing.enabled") === true}
                onChange={(v) => set("editing.enabled", v)}
                help={getPath(draft, "editing.enabled") === true ? "Ligado: o modelo escolhe até o máximo abaixo por vídeo." : "Desligado (padrão): a etapa 05b é pulada."}
              />
              <NumberInput
                label="Máximo de inserções por vídeo"
                value={getPath(draft, "editing.maxCuesPerVideo") as number | undefined}
                min={1}
                max={12}
                onChange={(v) => set("editing.maxCuesPerVideo", v)}
                help="Padrão 6. Sempre com pelo menos 4 s entre uma e outra, nunca no gancho nem no final."
                error={errorAt("editing.maxCuesPerVideo")}
              />
              <Slider
                label="Volume dos efeitos sonoros"
                value={(getPath(draft, "editing.sfxVolume") as number | undefined) ?? 0.35}
                min={0}
                max={1}
                step={0.05}
                format={(v) => `${Math.round(v * 100)}%`}
                onChange={(v) => set("editing.sfxVolume", v)}
                help="Em relação à narração. Padrão 35%."
                error={errorAt("editing.sfxVolume")}
              />
            </div>
          </Section>

          <Section id="cfg-chaves" icon={KeyRound} title="Chaves e acessos" description="Só mostramos se cada item está configurado. Valores secretos nunca saem do servidor nem podem ser editados aqui.">
            <div className="key-list">
              {settings.keys.map((k) => (
                <div key={k.name} className="key-row">
                  <div>
                    <b>{k.label}</b>
                    <span className="mono muted">{k.name}</span>
                  </div>
                  {k.configured ? (
                    <span className="badge good">
                      <CircleCheck size={13} /> configurada
                    </span>
                  ) : (
                    <span className="badge warn">
                      <CircleX size={13} /> não configurada
                    </span>
                  )}
                </div>
              ))}
            </div>
            {!settings.keys.find((k) => k.name === "YT_TOKEN_PATH")?.configured && (
              <p className="hint">
                Para publicar, autorize o canal uma vez: rode <code>npm run auth:youtube</code> na raiz do projeto (precisa do client secret em secrets/).
              </p>
            )}
            <p className="hint">Para alterar, edite o arquivo .env (ou a pasta secrets/) na raiz do projeto e reinicie o painel.</p>
          </Section>
        </div>

        <div className="cfg-side">
          <PreviewPanel runs={runs} captions={captions} visual={visual} fonts={settings.fonts} invalid={styleInvalid} />
        </div>
      </div>

      {(dirty || notice) && (
        <div className={`save-bar ${dirty ? "dirty" : ""}`} role="status">
          <div className="save-text">
            {dirty ? (
              <>
                <b>Alterações não salvas</b>
                <span>
                  {clientErrors.length
                    ? `${clientErrors.length} campo(s) para corrigir.`
                    : "As mudanças valem a partir da próxima execução do pipeline."}
                </span>
              </>
            ) : (
              notice && <span className={notice.tone === "good" ? "ok-text" : "bad-text"}>{notice.text}</span>
            )}
            {dirty && notice && <span className={notice.tone === "good" ? "ok-text" : "bad-text"}>{notice.text}</span>}
          </div>
          {dirty ? (
            <div className="save-actions">
              <button type="button" className="ghost" onClick={discard} disabled={saving}>
                <Undo2 size={14} /> Descartar
              </button>
              <button type="button" className="primary" onClick={() => void save()} disabled={saving || clientErrors.length > 0}>
                {saving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />} {saving ? "Salvando…" : "Salvar"}
              </button>
            </div>
          ) : (
            <button type="button" className="ghost" onClick={() => setNotice(null)}>
              Fechar
            </button>
          )}
        </div>
      )}
    </>
  );
}

function bounds(schema: unknown, path: string): { min?: number; max?: number } {
  const node = schemaAt(schema, path);
  return { min: node?.minimum, max: node?.maximum };
}

/* ---------- Voz ---------- */
type VoiceEngineId = "gemini" | "kokoro" | "edge-tts";
type VoiceDraft = { engine?: VoiceEngineId; name?: string; language?: string; rate?: string; pitch?: string; volume?: string; kokoroVoice?: string; kokoroSpeed?: number };
const VOICE_ENGINE_OPTIONS: { value: VoiceEngineId; label: string }[] = [
  { value: "gemini", label: "Gemini (API)" },
  { value: "kokoro", label: "Kokoro (local, grátis)" },
  { value: "edge-tts", label: "edge-tts" },
];
const KOKORO_VOICES = [
  { value: "pm_alex", label: "Alex (masculina)" },
  { value: "pf_dora", label: "Dora (feminina)" },
  { value: "pm_santa", label: "Santa (masculina)" },
];

function VoiceSection(props: {
  voice: VoiceDraft;
  defaults: { engine: VoiceEngineId; rate: string; pitch: string; volume: string; kokoroVoice: string; kokoroSpeed: number };
  set: (path: string, value: unknown) => void;
  errorAt: (path: string) => string | undefined;
}) {
  const { voice, set, errorAt } = props;
  const engine = voice.engine ?? props.defaults.engine;
  const [voices, setVoices] = useState<VoiceInfo[] | null>(null);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [locale, setLocale] = useState("pt-BR");
  const [query, setQuery] = useState("");
  const [sampleText, setSampleText] = useState(DEFAULT_SAMPLE);
  const [sample, setSample] = useState<{ busy: boolean; msg?: string; url?: string }>({ busy: false });
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    fetch("/api/voices")
      .then(async (r) => {
        const body = (await r.json()) as VoiceInfo[] | { message: string };
        if (!r.ok || !Array.isArray(body)) throw new Error("message" in body ? body.message : "Vozes indisponíveis.");
        setVoices(body);
      })
      .catch((e: unknown) => setVoicesError(e instanceof Error ? e.message : String(e)));
  }, []);

  const rate = parseDelta(voice.rate ?? props.defaults.rate);
  const pitch = parseDelta(voice.pitch ?? props.defaults.pitch);
  const volume = parseDelta(voice.volume ?? props.defaults.volume);
  const filtered = (voices ?? [])
    .filter((v) => v.locale === locale || v.locale.startsWith(`${locale}-`))
    .filter((v) => !query || `${v.name} ${v.friendlyName}`.toLowerCase().includes(query.toLowerCase()));
  const shortName = (v: VoiceInfo) => v.name.replace(/^[a-z]{2,3}-[A-Za-z]{2,4}-/, "").replace(/Neural$/, "").replace(/Multilingual$/, " (multilíngue)");

  const playSample = async () => {
    setSample({ busy: true });
    try {
      const res = await fetch("/api/voices/sample", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voice: voice.name,
          rate: formatDelta(rate, "%"),
          pitch: formatDelta(pitch, "Hz"),
          volume: formatDelta(volume, "%"),
          text: sampleText,
        }),
      });
      const body = (await res.json()) as VoiceSampleResponse;
      setSample({ busy: false, msg: body.message, url: body.url });
      if (body.ok && body.url && audioRef.current) {
        audioRef.current.src = body.url;
        void audioRef.current.play().catch(() => undefined);
      }
    } catch {
      setSample({ busy: false, msg: "Não foi possível gerar a amostra." });
    }
  };

  return (
    <Section
      id="cfg-voz"
      icon={Mic}
      title="Voz da narração"
      description="Motor da narração. A lista de vozes e a amostra abaixo são do edge-tts; o Kokoro roda no PC sem API paga."
      onReset={() => {
        set("voice.engine", undefined);
        set("voice.name", "pt-BR-AntonioNeural");
        set("voice.language", "pt-BR");
        set("voice.rate", undefined);
        set("voice.pitch", undefined);
        set("voice.volume", undefined);
        set("voice.kokoroVoice", undefined);
        set("voice.kokoroSpeed", undefined);
      }}
    >
      <div className="cfg-grid" style={{ marginBottom: 14 }}>
        <Segmented label="Motor" value={engine} options={VOICE_ENGINE_OPTIONS} onChange={(v) => set("voice.engine", v)} error={errorAt("voice.engine")} />
        {engine === "kokoro" && (
          <>
            <Segmented
              label="Voz do Kokoro"
              value={voice.kokoroVoice ?? props.defaults.kokoroVoice}
              options={KOKORO_VOICES}
              onChange={(v) => set("voice.kokoroVoice", v)}
              error={errorAt("voice.kokoroVoice")}
              help="Precisa do venv do Kokoro apontado em KOKORO_PYTHON (veja o README)."
            />
            <NumberInput
              label="Velocidade do Kokoro"
              value={voice.kokoroSpeed ?? props.defaults.kokoroSpeed}
              min={0.5}
              max={2}
              step={0.05}
              suffix="x"
              onChange={(v) => set("voice.kokoroSpeed", v)}
              error={errorAt("voice.kokoroSpeed")}
            />
          </>
        )}
      </div>
      <div className="voice-tools">
        <div className="chips-row" role="radiogroup" aria-label="Idioma">
          {LOCALES.map((l) => (
            <button key={l.id} type="button" role="radio" aria-checked={locale === l.id} className={`pill ${locale === l.id ? "on" : ""}`} onClick={() => setLocale(l.id)}>
              {l.label}
            </button>
          ))}
        </div>
        <div className="search">
          <Search size={14} />
          <input className="input" placeholder="Buscar voz…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Buscar voz" />
        </div>
      </div>
      {voicesError ? (
        <Empty icon={Mic} title="Lista de vozes indisponível">
          {voicesError} A voz atual ({voice.name}) continua valendo.
        </Empty>
      ) : !voices ? (
        <div className="muted" style={{ padding: 12 }}>
          <LoaderCircle size={14} className="spin" /> Carregando vozes…
        </div>
      ) : (
        <div className="voice-grid" role="radiogroup" aria-label="Voz">
          {filtered.map((v) => (
            <button
              key={v.name}
              type="button"
              role="radio"
              aria-checked={voice.name === v.name}
              className={`voice-card ${voice.name === v.name ? "on" : ""}`}
              onClick={() => {
                set("voice.name", v.name);
                set("voice.language", v.locale);
              }}
            >
              <span className="voice-avatar" data-gender={v.gender}>
                {shortName(v).charAt(0)}
              </span>
              <span className="voice-text">
                <b>{shortName(v)}</b>
                <span>
                  {v.gender === "Female" ? "Feminina" : v.gender === "Male" ? "Masculina" : v.gender} · {v.locale}
                </span>
              </span>
            </button>
          ))}
          {filtered.length === 0 && <span className="muted">Nenhuma voz encontrada.</span>}
        </div>
      )}
      {errorAt("voice.name") && <span className="field-error">{errorAt("voice.name")}</span>}

      <div className="cfg-grid" style={{ marginTop: 14 }}>
        <Slider label="Velocidade" value={rate} min={-50} max={50} format={(v) => formatDelta(v, "%")} onChange={(v) => set("voice.rate", formatDelta(v, "%"))} error={errorAt("voice.rate")} help="+10% deixa o ritmo mais ágil, típico de Shorts." />
        <Slider label="Tom" value={pitch} min={-20} max={20} format={(v) => formatDelta(v, "Hz")} onChange={(v) => set("voice.pitch", formatDelta(v, "Hz"))} error={errorAt("voice.pitch")} />
        <Slider label="Volume" value={volume} min={-50} max={50} format={(v) => formatDelta(v, "%")} onChange={(v) => set("voice.volume", formatDelta(v, "%"))} error={errorAt("voice.volume")} />
      </div>

      <div className="sample-box">
        <textarea className="input" rows={2} maxLength={300} value={sampleText} onChange={(e) => setSampleText(e.target.value)} aria-label="Frase de amostra" />
        <div className="sample-actions">
          <button type="button" className="primary" onClick={() => void playSample()} disabled={sample.busy || !voice.name || !sampleText.trim()}>
            {sample.busy ? <LoaderCircle size={14} className="spin" /> : <Play size={14} fill="currentColor" />} {sample.busy ? "Gerando…" : "Ouvir amostra"}
          </button>
          <audio ref={audioRef} controls preload="none" className={sample.url ? "" : "hidden"} />
          {sample.msg && <span className="muted">{sample.msg}</span>}
        </div>
      </div>
    </Section>
  );
}

/* ---------- Temas ---------- */
function TopicsSection(props: {
  categories: TopicCategory[];
  originalIds: Set<string>;
  onChange: (c: TopicCategory[]) => void;
  errorAt: (path: string) => string | undefined;
}) {
  const { categories, originalIds, onChange, errorAt } = props;
  const update = (i: number, patch: Partial<TopicCategory>) => onChange(categories.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const infos = categories.map((c) => ({ id: c.id, label: c.label }));
  return (
    <Section id="cfg-temas" icon={Layers} title="Temas" description="Categorias de curiosidades e as ideias (prompts) que o roteirista sorteia.">
      <div className="topics">
        {categories.map((c, i) => {
          const isNew = !originalIds.has(c.id) || categories.findIndex((x) => x.id === c.id) !== i;
          return (
            <div key={i} className="topic-card" style={{ "--chip": categoryColor(c.id, infos) } as CSSProperties}>
              <div className="topic-head">
                <span className="topic-dot" title={i < 3 ? "Cor fixa desta posição" : "A partir da 4ª categoria a cor é cinza (Outros)"} />
                <TextInput
                  label="Nome"
                  value={c.label}
                  onChange={(v) => update(i, isNew ? { label: v, id: slugify(v) || c.id } : { label: v })}
                  error={errorAt(`categories.${i}.label`)}
                />
                <TextInput
                  label="Id"
                  value={c.id}
                  readOnly={!isNew}
                  onChange={(v) => update(i, { id: v })}
                  help={isNew ? "Gerado a partir do nome." : "Fixo: execuções antigas usam este id."}
                  error={errorAt(`categories.${i}.id`)}
                />
                <button
                  type="button"
                  className="ghost icon-btn"
                  aria-label={`Remover ${c.label || "categoria"}`}
                  disabled={categories.length <= 1}
                  onClick={() => {
                    if (window.confirm(`Remover a categoria "${c.label}" e seus prompts?`)) onChange(categories.filter((_, j) => j !== i));
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <div className="prompts">
                {c.prompts.map((p, j) => (
                  <div key={j} className={`prompt-row ${errorAt(`categories.${i}.prompts.${j}`) ? "has-error" : ""}`}>
                    <textarea
                      className="input"
                      rows={2}
                      value={p}
                      aria-label={`Prompt ${j + 1} de ${c.label}`}
                      onChange={(e) => update(i, { prompts: c.prompts.map((x, k) => (k === j ? e.target.value : x)) })}
                    />
                    <button type="button" className="ghost icon-btn" aria-label="Remover prompt" onClick={() => update(i, { prompts: c.prompts.filter((_, k) => k !== j) })}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                {errorAt(`categories.${i}.prompts`) && <span className="field-error">{errorAt(`categories.${i}.prompts`)}</span>}
                <button type="button" className="ghost add-btn" onClick={() => update(i, { prompts: [...c.prompts, ""] })}>
                  <Plus size={14} /> Adicionar prompt
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <button type="button" className="ghost add-btn" onClick={() => onChange([...categories, { id: "", label: "", prompts: [""] }])}>
        <Plus size={14} /> Nova categoria
      </button>
      <p className="hint">
        <Clapperboard size={12} /> As 3 primeiras categorias têm cor fixa (azul, laranja, verde) em todo o painel; a partir da 4ª, aparecem em cinza como “Outros”.
      </p>
    </Section>
  );
}
