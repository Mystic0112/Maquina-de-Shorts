import { ExternalLink, Film, ListVideo, Play } from "lucide-react";
import { useState } from "react";

type Kind = "short" | "cut" | "all";
const KIND_OPTIONS: { value: Kind; label: string }[] = [
  { value: "short", label: "Nossos vídeos" },
  { value: "cut", label: "Cortes" },
  { value: "all", label: "Tudo" },
];
const KIND_KEY = "videos.kind";

function savedKind(): Kind {
  try {
    const v = localStorage.getItem(KIND_KEY);
    return v === "cut" || v === "all" ? v : "short";
  } catch {
    return "short";
  }
}
import type { CategoryInfo, VideoRow } from "../../shared/api";
import { Card, CategoryChip, Empty, PathCopy, PlayerModal, StatusBadge, toPlayable, VideoCard, type PlayableVideo } from "../components";
import { fmtDateTime, fmtDuration, fmtInt } from "../format";
import { UploadBadge } from "../runDetails";

const PRIVACY_LABEL: Record<string, string> = { public: "público", unlisted: "não listado", private: "privado" };

export function Videos({ rows: allRows, historyExists, categories }: { rows: VideoRow[]; historyExists: boolean; categories: CategoryInfo[] }) {
  const [playing, setPlaying] = useState<PlayableVideo | null>(null);
  const [kind, setKind] = useState<Kind>(savedKind);
  const choose = (k: Kind) => {
    setKind(k);
    try {
      localStorage.setItem(KIND_KEY, k);
    } catch {
      // private window: the choice just is not remembered
    }
  };
  const rows = kind === "all" ? allRows : allRows.filter((r) => r.kind === kind);
  const playable = rows.filter((r) => r.localUrl).map(toPlayable);
  const noun = kind === "cut" ? "corte(s)" : "vídeo(s)";
  const picker = (
    <select className="input kind-select" value={kind} aria-label="Mostrar" onChange={(e) => choose(e.target.value as Kind)}>
      {KIND_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label} ({o.value === "all" ? allRows.length : allRows.filter((r) => r.kind === o.value).length})
        </option>
      ))}
    </select>
  );

  return (
    <>
      <Card title="Galeria" icon={Film} sub={`${playable.length} ${noun} renderizado(s) disponíveis no disco`} actions={picker}>
        {playable.length ? (
          <div className="gallery wrap">
            {playable.map((v) => (
              <VideoCard key={v.key} video={v} categories={categories} onOpen={() => setPlaying(v)} />
            ))}
          </div>
        ) : (
          <Empty icon={Film} title={kind === "cut" ? "Nenhum corte no disco" : "Nenhum vídeo no disco"}>
            {kind === "cut" ? "Os cortes aparecem aqui quando o comando npm run cuts terminar de renderizar." : "Os vídeos aparecem aqui assim que o render terminar."}
          </Empty>
        )}
      </Card>
      <div style={{ height: 14 }} />

      <Card
        title={`Todas as execuções e publicações (${rows.length})`}
        icon={ListVideo}
        sub={
          historyExists
            ? undefined
            : "Nenhum vídeo publicado ainda: data/history.json será criado pela etapa de upload. Views e likes aparecem depois disso."
        }
      >
        {rows.length === 0 ? (
          <Empty icon={ListVideo} title="Nenhuma execução encontrada">
            Nada em render_output/ nem em logs/ ainda.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th />
                  <th>Título</th>
                  <th>Data</th>
                  <th>Status</th>
                  <th className="num">Duração</th>
                  <th className="num">Views</th>
                  <th className="num">Likes</th>
                  <th>YouTube</th>
                  <th>Arquivo local</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td style={{ width: 52 }}>
                      {row.thumbUrl ? (
                        <img className="mini-thumb" src={row.thumbUrl} alt="" loading="lazy" />
                      ) : (
                        <div className="mini-thumb" />
                      )}
                    </td>
                    <td style={{ minWidth: 240 }}>
                      <div style={{ fontWeight: 600 }}>{row.title}</div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
                        {row.kind === "cut" ? <CategoryChip id="corte" label={`Corte · ${row.cutChannel ?? "canal"}`} categories={categories} /> : <CategoryChip id={row.categoryId} categories={categories} />}
                        {row.runId && <span className="mono muted nowrap">{row.runId}</span>}
                      </div>
                    </td>
                    <td className="nowrap">{fmtDateTime(row.date)}</td>
                    <td>
                      <StatusBadge status={row.status} />
                    </td>
                    <td className="num">{row.videoDurationSeconds == null ? "—" : fmtDuration(row.videoDurationSeconds * 1000)}</td>
                    <td className="num">{fmtInt(row.youtube?.stats?.views)}</td>
                    <td className="num">{fmtInt(row.youtube?.stats?.likes)}</td>
                    <td className="nowrap">
                      {row.youtube ? (
                        <a className="link-btn" href={row.youtube.url} target="_blank" rel="noreferrer">
                          <ExternalLink size={13} /> abrir
                          <span className="muted"> ({PRIVACY_LABEL[row.youtube.privacyStatus] ?? row.youtube.privacyStatus})</span>
                        </a>
                      ) : row.upload ? (
                        <UploadBadge upload={row.upload} />
                      ) : (
                        <span className="muted">não publicado</span>
                      )}
                    </td>
                    <td>
                      {row.localPath && row.localUrl ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <button type="button" className="ghost" style={{ alignSelf: "flex-start", padding: "2px 6px" }} onClick={() => setPlaying(toPlayable(row))}>
                            <Play size={13} /> assistir
                          </button>
                          <PathCopy path={row.localPath} />
                        </div>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {playing && <PlayerModal video={playing} categories={categories} onClose={() => setPlaying(null)} />}
    </>
  );
}
