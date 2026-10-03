// Detail blocks for the new pipeline stages: 02b fact-check, 07 metadata, 08 upload, run rejections.
import { ArrowRight, BadgeCheck, CloudOff, CloudUpload, ExternalLink, Gauge, Lock, ShieldAlert, ShieldCheck, ShieldX, Tags } from "lucide-react";
import type { FactCheckSummary, RunRejection, UploadResult, VideoMetadata } from "../shared/api";
import { fmtDateTime, fmtInt, STAGE_LABEL } from "./format";

const PRIVACY: Record<string, string> = { public: "público", unlisted: "não listado", private: "privado" };

export function UploadBadge({ upload }: { upload: UploadResult | null }) {
  if (!upload) return null;
  if (upload.status === "uploaded" && upload.lockedPrivate) {
    return (
      <span className="badge serious" title={`Pedido: ${PRIVACY[upload.requestedPrivacyStatus] ?? upload.requestedPrivacyStatus}; o YouTube aplicou privado (projeto de API não auditado).`}>
        <Lock size={13} /> Enviado · travado como privado
      </span>
    );
  }
  if (upload.status === "uploaded") {
    return (
      <span className="badge good">
        <CloudUpload size={13} /> Enviado · {PRIVACY[upload.privacyStatus ?? upload.requestedPrivacyStatus] ?? upload.privacyStatus}
      </span>
    );
  }
  if (upload.status === "skipped-cap") {
    return (
      <span className="badge warn" title={upload.reason}>
        <Gauge size={13} /> Pulado: limite diário
      </span>
    );
  }
  return (
    <span className="badge" title={upload.reason ?? "upload.enabled = false nas Configurações"}>
      <CloudOff size={13} /> Pulado: upload desligado
    </span>
  );
}

const FACT_VERDICT: Record<FactCheckSummary["verdict"], { label: string; tone: string; icon: typeof ShieldCheck }> = {
  pass: { label: "Aprovado sem mudanças", tone: "good", icon: ShieldCheck },
  corrected: { label: "Corrigido e verificado", tone: "info", icon: BadgeCheck },
  fail: { label: "Reprovado", tone: "bad", icon: ShieldX },
  skipped: { label: "Checagem desligada", tone: "", icon: ShieldAlert },
};

const domainOf = (uri: string, title?: string): string => {
  if (title && !/^https?:/.test(title)) return title;
  try {
    return new URL(uri).hostname.replace(/^www\./, "");
  } catch {
    return uri;
  }
};

export function FactCheckPanel({ factCheck }: { factCheck: Omit<FactCheckSummary, "originalScript"> }) {
  const meta = FACT_VERDICT[factCheck.verdict];
  const Icon = meta.icon;
  const flagged = factCheck.claims.filter((c) => c.verdict !== "supported" && c.correction);
  const lastRound = Math.max(0, ...factCheck.claims.map((c) => c.round));
  const finalFlags = factCheck.claims.filter((c) => c.round === lastRound && c.verdict !== "supported").length;
  return (
    <div className="detail-block">
      <div className="detail-head">
        <b>
          <ShieldCheck size={15} /> Checagem de fatos
        </b>
        <span className={`badge ${meta.tone}`}>
          <Icon size={13} /> {meta.label}
        </span>
        <span className="muted">
          {fmtInt(factCheck.claimsChecked)} afirmações · {factCheck.rounds} rodada(s)
          {factCheck.verdict !== "skipped" && ` · ${finalFlags ? `${finalFlags} pendente(s) na última rodada` : "tudo confirmado na última rodada"}`}
        </span>
      </div>
      {factCheck.titleBefore && factCheck.titleAfter && factCheck.titleBefore !== factCheck.titleAfter && (
        <div className="fix-row">
          <span className="fix-before">{factCheck.titleBefore}</span>
          <ArrowRight size={14} />
          <span className="fix-after">{factCheck.titleAfter}</span>
        </div>
      )}
      {flagged.length > 0 && (
        <div className="fixes">
          {flagged.map((c, i) => (
            <div key={i} className="fix-row">
              <span className="fix-round">R{c.round}</span>
              <span className="fix-before" title={c.verdict === "misleading" ? "Enganoso" : "Sem respaldo"}>
                {c.claim}
              </span>
              <ArrowRight size={14} />
              <span className="fix-after">{c.correction}</span>
            </div>
          ))}
        </div>
      )}
      {factCheck.reason && <p className="hint">{factCheck.reason}</p>}
      {factCheck.sources.length > 0 && (
        <div className="sources">
          <span className="muted">Fontes consultadas:</span>
          {factCheck.sources.slice(0, 12).map((s, i) => (
            <a key={i} href={s.uri} target="_blank" rel="noreferrer noopener" className="source-chip">
              <ExternalLink size={11} /> {domainOf(s.uri, s.title)}
            </a>
          ))}
          {factCheck.sources.length > 12 && <span className="muted">+{factCheck.sources.length - 12}</span>}
        </div>
      )}
    </div>
  );
}

export function MetadataPreview({ metadata }: { metadata: VideoMetadata }) {
  return (
    <div className="detail-block">
      <div className="detail-head">
        <b>
          <Tags size={15} /> Metadados do YouTube
        </b>
        <span className="muted">
          {metadata.title.length}/100 caracteres no título · {metadata.tags.length} tags
        </span>
      </div>
      <div className="yt-meta">
        <div className="yt-title">{metadata.title}</div>
        <details>
          <summary>Descrição ({metadata.description.length} caracteres)</summary>
          <pre className="yt-desc">{metadata.description}</pre>
        </details>
        <div className="tag-list">
          {metadata.tags.map((t) => (
            <span key={t} className="tag">
              {t}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function RejectionBox({ rejection }: { rejection: RunRejection }) {
  return (
    <div className="failure rejection">
      <b>
        <ShieldX size={14} color="var(--warning)" /> Reprovado em {STAGE_LABEL[rejection.stage] ?? rejection.stage}
      </b>
      {rejection.attempt != null && ` · tentativa ${rejection.attempt}${rejection.maxAttempts ? ` de ${rejection.maxAttempts}` : ""}`}
      <pre className="mono">{rejection.reason}</pre>
      {rejection.retriedAs && <span className="muted">Refeito com outro tema como {rejection.retriedAs}.</span>}
    </div>
  );
}

export function UploadDetail({ upload }: { upload: UploadResult }) {
  return (
    <div className="detail-block">
      <div className="detail-head">
        <b>
          <CloudUpload size={15} /> Upload
        </b>
        <UploadBadge upload={upload} />
        {upload.uploadedAt && <span className="muted">{fmtDateTime(upload.uploadedAt)}</span>}
        {upload.url && (
          <a className="link-btn" href={upload.url} target="_blank" rel="noreferrer">
            <ExternalLink size={13} /> abrir no YouTube
          </a>
        )}
      </div>
      {upload.reason && <p className="hint">{upload.reason}</p>}
    </div>
  );
}
