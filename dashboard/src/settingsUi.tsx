// Form controls for the Configurações page (same visual language as the rest of the dashboard).
import { Check, RotateCcw, type LucideIcon } from "lucide-react";
import { useId, type CSSProperties, type ReactNode } from "react";

export function Section(props: {
  id: string;
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  onReset?: () => void;
  resetLabel?: string;
  children: ReactNode;
}) {
  const { id, icon: Icon, title, description, onReset, resetLabel = "Restaurar padrões", children } = props;
  return (
    <section className="card cfg-section" id={id}>
      <div className="cfg-head">
        <div className="cfg-icon">
          <Icon size={18} />
        </div>
        <div className="cfg-title">
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {onReset && (
          <button type="button" className="ghost cfg-reset" onClick={onReset} title={resetLabel}>
            <RotateCcw size={13} />
            <span>{resetLabel}</span>
          </button>
        )}
      </div>
      <div className="cfg-body">{children}</div>
    </section>
  );
}

export function Field(props: { label: string; help?: ReactNode; error?: string; children: ReactNode; wide?: boolean; htmlFor?: string }) {
  return (
    <div className={`field ${props.wide ? "wide" : ""} ${props.error ? "has-error" : ""}`}>
      <label className="field-label" htmlFor={props.htmlFor}>
        {props.label}
      </label>
      {props.children}
      {props.error ? <span className="field-error">{props.error}</span> : props.help ? <span className="field-help">{props.help}</span> : null}
    </div>
  );
}

export function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  help?: ReactNode;
  error?: string;
  marks?: ReactNode;
}) {
  const id = useId();
  const { value, min, max, step = 1, format = String, onChange } = props;
  const pct = ((value - min) / (max - min || 1)) * 100;
  return (
    <Field label={props.label} help={props.help} error={props.error} htmlFor={id}>
      <div className="slider">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{ "--pct": `${pct}%` } as CSSProperties}
        />
        <output htmlFor={id}>{format(value)}</output>
      </div>
      {props.marks}
    </Field>
  );
}

export function Switch(props: { label: string; checked: boolean; onChange: (v: boolean) => void; help?: ReactNode }) {
  return (
    <div className="field switch-field">
      <button type="button" role="switch" aria-checked={props.checked} className={`switch ${props.checked ? "on" : ""}`} onClick={() => props.onChange(!props.checked)}>
        <span />
      </button>
      <div>
        <span className="field-label" onClick={() => props.onChange(!props.checked)}>
          {props.label}
        </span>
        {props.help && <span className="field-help">{props.help}</span>}
      </div>
    </div>
  );
}

export function Segmented<T extends string | number>(props: {
  label: string;
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  help?: ReactNode;
  error?: string;
}) {
  return (
    <Field label={props.label} help={props.help} error={props.error}>
      <div className="segmented" role="radiogroup" aria-label={props.label}>
        {props.options.map((o) => (
          <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === props.value} className={o.value === props.value ? "on" : ""} onClick={() => props.onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </Field>
  );
}

/**
 * Multi-select as icon chips; keeps the result in `options` order and never lets the selection drop
 * below `min` (the last selected chip is disabled instead of silently emptying the list).
 */
export function ChipMultiSelect<T extends string>(props: {
  label: string;
  value: readonly T[];
  options: readonly { value: T; label: string; hint?: string; icon: LucideIcon }[];
  onChange: (v: T[]) => void;
  min?: number;
  help?: ReactNode;
  error?: string;
}) {
  const { value, options, min = 0 } = props;
  const selected = new Set(value);
  const toggle = (v: T) => {
    const next = new Set(selected);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    props.onChange(options.map((o) => o.value).filter((o) => next.has(o)));
  };
  return (
    <Field label={props.label} help={props.help} error={props.error} wide>
      <div className="format-chips" role="group" aria-label={props.label}>
        {options.map((o) => {
          const on = selected.has(o.value);
          const locked = on && selected.size <= min;
          return (
            <button
              key={o.value}
              type="button"
              role="checkbox"
              aria-checked={on}
              className={`format-chip ${on ? "on" : ""}`}
              disabled={locked}
              title={locked ? `Mantenha pelo menos ${min} selecionado(s).` : undefined}
              onClick={() => toggle(o.value)}
            >
              <span className="fc-icon">
                <o.icon size={15} />
              </span>
              {on && <Check size={14} className="fc-check" />}
              <span className="fc-text">
                <b>{o.label}</b>
                {o.hint && <span>{o.hint}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </Field>
  );
}

export function NumberInput(props: {
  label: string;
  value: number | undefined;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  onChange: (v: number | undefined) => void;
  help?: ReactNode;
  error?: string;
}) {
  const id = useId();
  return (
    <Field label={props.label} help={props.help} error={props.error} htmlFor={id}>
      <div className="input-wrap">
        <input
          id={id}
          className="input"
          type="number"
          inputMode="numeric"
          min={props.min}
          max={props.max}
          step={props.step ?? 1}
          value={props.value ?? ""}
          onChange={(e) => props.onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        />
        {props.suffix && <span className="suffix">{props.suffix}</span>}
      </div>
    </Field>
  );
}

export function TextInput(props: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; maxLength?: number; help?: ReactNode; error?: string; readOnly?: boolean }) {
  const id = useId();
  return (
    <Field label={props.label} help={props.help} error={props.error} htmlFor={id}>
      <input
        id={id}
        className="input"
        value={props.value}
        placeholder={props.placeholder}
        maxLength={props.maxLength}
        readOnly={props.readOnly}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </Field>
  );
}

const PRESETS: Record<string, string[]> = {
  text: ["#FFFFFF", "#F5F5F0", "#FFE11A", "#000000"],
  highlight: ["#FFE11A", "#22D3EE", "#A3E635", "#FB7185", "#F97316", "#C084FC"],
  stroke: ["#000000", "#1F2937", "#3B0764", "#FFFFFF"],
};

export function ColorField(props: { label: string; value: string; presets: keyof typeof PRESETS; onChange: (v: string) => void; error?: string }) {
  const id = useId();
  const valid = /^#[0-9a-fA-F]{6}$/.test(props.value);
  return (
    <Field label={props.label} error={props.error} htmlFor={id}>
      <div className="color-field">
        <input type="color" aria-label={`${props.label}: seletor`} value={valid ? props.value : "#000000"} onChange={(e) => props.onChange(e.target.value.toUpperCase())} />
        <input id={id} className="input mono" value={props.value} maxLength={7} onChange={(e) => props.onChange(e.target.value.toUpperCase())} />
        <div className="swatches">
          {PRESETS[props.presets]!.map((c) => (
            <button
              key={c}
              type="button"
              className={`swatch ${c.toUpperCase() === props.value.toUpperCase() ? "on" : ""}`}
              style={{ background: c }}
              title={c}
              aria-label={`Usar ${c}`}
              onClick={() => props.onChange(c)}
            />
          ))}
        </div>
      </div>
    </Field>
  );
}
