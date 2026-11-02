// Configurações > Voz: the fields of the engines that need more than a voice name (Chatterbox, ElevenLabs).
// Kokoro's fields stay in pages/Settings.tsx.
import { LoaderCircle, TriangleAlert, Upload } from "lucide-react";
import { useRef, useState } from "react";
import type { VoiceExtras } from "../../src/shared/settings";
import { Field, Segmented, Slider, TextInput } from "./settingsUi";

type Props = {
  voice: VoiceExtras;
  defaults: Required<VoiceExtras>;
  set: (path: string, value: unknown) => void;
  errorAt: (path: string) => string | undefined;
};

const Warning = ({ children }: { children: React.ReactNode }) => (
  <div className="banner" style={{ gridColumn: "1 / -1", marginBottom: 0 }}>
    <TriangleAlert size={16} color="var(--critical)" style={{ flex: "none" }} />
    <div>{children}</div>
  </div>
);

export function ChatterboxFields({ voice, defaults, set, errorAt }: Props) {
  const ref = voice.chatterboxRefAudio ?? defaults.chatterboxRefAudio;
  const fileRef = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<{ busy: boolean; msg?: string; bad?: boolean; v: number }>({ busy: false, v: Date.now() });

  const send = async (file: File) => {
    setUpload((u) => ({ ...u, busy: true, msg: undefined }));
    try {
      const res = await fetch("/api/voice/reference", { method: "PUT", headers: { "Content-Type": file.type.startsWith("audio/") ? file.type : "audio/wav" }, body: file });
      const out = (await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status} (máximo 10 MB)` }))) as { ok: boolean; message: string; path?: string };
      if (!out.ok || !out.path) return setUpload((u) => ({ ...u, busy: false, msg: out.message, bad: true }));
      set("voice.chatterboxRefAudio", out.path);
      setUpload({ busy: false, msg: "Gravação enviada. Salve para valer nos próximos vídeos.", v: Date.now() });
    } catch (e) {
      setUpload((u) => ({ ...u, busy: false, msg: e instanceof Error ? e.message : String(e), bad: true }));
    }
  };

  return (
    <>
      <Warning>
        <b>Só use uma voz que seja sua ou de quem autorizou, por escrito.</b> Clonar a voz de outra pessoa sem consentimento pode violar direitos dela e as regras do YouTube. O Chatterbox
        grava uma marca d’água inaudível (Perth) em todo áudio; não tente removê-la.
      </Warning>
      <Field label="Voz de referência (gravação de 10 a 15 s)" help="WAV, MP3 ou FLAC com fala limpa, sem música nem ruído, até 10 MB. Fica só neste PC (data/voice_ref/), fora do GitHub. Sem gravação, usa a voz padrão do modelo." error={errorAt("voice.chatterboxRefAudio")}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" className="ghost" disabled={upload.busy} onClick={() => fileRef.current?.click()}>
            {upload.busy ? <LoaderCircle size={14} className="spin" /> : <Upload size={14} />} {ref ? "Trocar gravação" : "Enviar gravação"}
          </button>
          {ref ? (
            <button
              type="button"
              className="ghost"
              onClick={() => {
                void fetch("/api/voice/reference", { method: "DELETE" }).catch(() => undefined);
                set("voice.chatterboxRefAudio", "");
              }}
            >
              Apagar gravação
            </button>
          ) : null}
          {ref ? <audio controls preload="none" src={`/api/voice/reference?v=${upload.v}`} style={{ height: 32, maxWidth: 260 }} /> : null}
          <input ref={fileRef} type="file" accept="audio/*,.wav,.mp3,.flac" hidden onChange={(e) => e.target.files?.[0] && void send(e.target.files[0])} />
        </div>
        {upload.msg && <span className={upload.bad ? "bad-text" : "ok-text"}>{upload.msg}</span>}
      </Field>
      <Segmented
        label="Modelo"
        value={voice.chatterboxMode ?? defaults.chatterboxMode}
        options={[
          { value: "v3" as const, label: "v3 (padrão)" },
          { value: "pt-br" as const, label: "pt-BR (melhor, baixa ~8 GB uma vez)" },
        ]}
        onChange={(v) => set("voice.chatterboxMode", v)}
        error={errorAt("voice.chatterboxMode")}
        help="Medido em casa com a mesma frase: v3 erra 7,5 a 9,4% das palavras; pt-BR erra 6,6% (igual ao Kokoro) com voz de referência. O pt-BR monta o modelo na primeira execução."
      />
      <Slider label="Expressividade" value={voice.chatterboxExaggeration ?? defaults.chatterboxExaggeration} min={0.25} max={2} step={0.05} format={(v) => v.toFixed(2)} onChange={(v) => set("voice.chatterboxExaggeration", v)} error={errorAt("voice.chatterboxExaggeration")} help="0,50 é neutro; mais alto dramatiza." />
      <Slider label="Ritmo (cfg)" value={voice.chatterboxCfgWeight ?? defaults.chatterboxCfgWeight} min={0} max={1} step={0.05} format={(v) => v.toFixed(2)} onChange={(v) => set("voice.chatterboxCfgWeight", v)} error={errorAt("voice.chatterboxCfgWeight")} help="Mais baixo = fala mais pausada." />
      <span className="field-help" style={{ gridColumn: "1 / -1" }}>
        Roda no PC (placa de vídeo, ~4 GB de VRAM, 35 a 60 s por ~40 s de áudio) em um ambiente Python separado apontado em CHATTERBOX_PYTHON no .env (veja o README, seção Voz: Chatterbox). Licença MIT.
      </span>
    </>
  );
}

export function ElevenLabsFields({ voice, defaults, set, errorAt, keySet }: Props & { keySet: boolean | undefined }) {
  return (
    <>
      <Warning>
        <b>ElevenLabs é uma API de terceiros, ligada à sua chave.</b> O plano <b>Free</b> dá 10 mil créditos por mês (cerca de 11 Shorts), mas <b>só vale para uso não comercial</b> (Termos de Uso, §1(c)):
        um canal monetizado precisa do plano <b>Starter</b> (US$ 6/mês) ou superior, que traz licença comercial. Use a sua própria chave; não distribua chave de terceiros nem crie várias contas grátis
        para esticar a cota (Política de Uso, §8 e §12). Nunca é o padrão: só funciona se você escolher este motor.
      </Warning>
      <div className="field">
        <span className="field-label">Chave de API</span>
        <span className={keySet ? "ok-text" : "bad-text"}>{keySet ? "Configurada." : "Falta a ELEVENLABS_API_KEY."}</span>
        <span className="field-help">Cole em “Chaves e acessos” (mais abaixo) ou ponha ELEVENLABS_API_KEY no .env. O painel nunca mostra o valor.</span>
      </div>
      <TextInput
        label="ID da voz"
        value={voice.elevenlabsVoiceId ?? defaults.elevenlabsVoiceId}
        maxLength={40}
        placeholder="ex.: 21m00Tcm4TlvDq8ikWAM"
        onChange={(v) => set("voice.elevenlabsVoiceId", v.trim())}
        error={errorAt("voice.elevenlabsVoiceId")}
        help="Copie o ID da voz da sua biblioteca no site da ElevenLabs. Obrigatório; só letras e números."
      />
      <TextInput
        label="Modelo"
        value={voice.elevenlabsModel ?? defaults.elevenlabsModel}
        maxLength={60}
        onChange={(v) => set("voice.elevenlabsModel", v.trim())}
        error={errorAt("voice.elevenlabsModel")}
        help="eleven_multilingual_v2 (mais fiel) ou eleven_flash_v2_5 (mais barato e rápido)."
      />
      <Slider label="Estabilidade" value={voice.elevenlabsStability ?? defaults.elevenlabsStability} min={0} max={1} step={0.05} format={(v) => v.toFixed(2)} onChange={(v) => set("voice.elevenlabsStability", v)} error={errorAt("voice.elevenlabsStability")} help="Baixa = mais expressiva; alta = mais monótona." />
    </>
  );
}
