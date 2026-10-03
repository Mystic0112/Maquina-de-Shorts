// Pure helpers for the Configurações page: immutable path edits, client-side validation driven by the
// server's JSON Schema (same rules the server enforces with zod), and the edge-tts value formats.
import type { FieldError, TopicCategory } from "../shared/api";

export type Json = Record<string, unknown>;

export function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Json)[k] : undefined), obj);
}

/** Returns a copy of obj with path set (undefined deletes the key; empty parents are pruned). */
export function setPath<T>(obj: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split(".");
  const src = (obj && typeof obj === "object" ? obj : {}) as Json;
  const copy: Json = Array.isArray(src) ? ([...src] as unknown as Json) : { ...src };
  if (!head) return obj;
  if (rest.length === 0) {
    if (value === undefined) delete copy[head];
    else copy[head] = value;
  } else {
    const child = setPath(src[head], rest.join("."), value) as Json;
    if (child && typeof child === "object" && !Array.isArray(child) && Object.keys(child).length === 0) delete copy[head];
    else copy[head] = child;
  }
  return copy as T;
}

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/* ---------- JSON Schema (subset emitted by zod's toJSONSchema) ---------- */
export interface SchemaNode {
  type?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  enum?: unknown[];
  minItems?: number;
}

export function schemaAt(schema: unknown, path: string): SchemaNode | undefined {
  let node = schema as SchemaNode | undefined;
  for (const key of path.split(".")) node = node?.properties?.[key];
  return node;
}

const num = (n: number) => String(n).replace(".", ",");

function check(node: SchemaNode, value: unknown, path: string, out: FieldError[]): void {
  const push = (message: string): void => void out.push({ path, message });
  switch (node.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return push("Valor inválido.");
      for (const [key, child] of Object.entries(node.properties ?? {})) {
        const v = (value as Json)[key];
        const childPath = path ? `${path}.${key}` : key;
        if (v === undefined) {
          if (node.required?.includes(key)) out.push({ path: childPath, message: "Campo obrigatório." });
          continue;
        }
        check(child, v, childPath, out);
      }
      return;
    }
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return push("Informe um número.");
      if (node.type === "integer" && !Number.isInteger(value)) return push("Use um número inteiro.");
      if (node.minimum != null && value < node.minimum) return push(`O valor mínimo é ${num(node.minimum)}.`);
      if (node.maximum != null && value > node.maximum) return push(`O valor máximo é ${num(node.maximum)}.`);
      if (node.exclusiveMinimum != null && value <= node.exclusiveMinimum) return push(`Deve ser maior que ${num(node.exclusiveMinimum)}.`);
      if (node.exclusiveMaximum != null && value >= node.exclusiveMaximum) return push(`Deve ser menor que ${num(node.exclusiveMaximum)}.`);
      return;
    }
    case "string": {
      if (typeof value !== "string") return push("Valor inválido.");
      if (node.enum && !node.enum.includes(value)) return push("Opção inválida.");
      if (node.minLength != null && value.length < node.minLength) return push("Campo obrigatório.");
      if (node.maxLength != null && value.length > node.maxLength) return push(`Máximo de ${node.maxLength} caracteres.`);
      if (node.pattern && !new RegExp(node.pattern).test(value)) return push(path.endsWith("Color") ? "Use uma cor no formato #RRGGBB." : "Formato inválido.");
      return;
    }
    case "boolean":
      if (typeof value !== "boolean") push("Valor inválido.");
      return;
    case "array":
      if (!Array.isArray(value)) return push("Valor inválido.");
      if (node.minItems != null && value.length < node.minItems) return push(`Informe pelo menos ${node.minItems} item(ns).`);
      if (node.items) value.forEach((v, i) => check(node.items!, v, `${path}.${i}`, out));
      return;
    default:
      if (node.enum && !node.enum.includes(value)) push("Opção inválida.");
  }
}

export function validateSettings(schema: unknown, config: Json): FieldError[] {
  const out: FieldError[] = [];
  if (schema) check(schema as SchemaNode, config, "", out);
  const n = (p: string) => getPath(config, p) as number | undefined;
  const pair = (a: string, b: string, message: string) => {
    const x = n(a);
    const y = n(b);
    if (typeof x === "number" && typeof y === "number" && x > y) out.push({ path: b, message });
  };
  pair("video.minSeconds", "video.maxSeconds", "A duração máxima deve ser maior ou igual à mínima.");
  pair("script.minWords", "script.maxWords", "O máximo de palavras deve ser maior ou igual ao mínimo.");
  pair("script.minScenes", "script.maxScenes", "O máximo de cenas deve ser maior ou igual ao mínimo.");
  return out;
}

export const TOPIC_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function validateTopics(categories: TopicCategory[]): FieldError[] {
  const out: FieldError[] = [];
  if (!categories.length) out.push({ path: "categories", message: "Mantenha pelo menos uma categoria." });
  const seen = new Set<string>();
  categories.forEach((c, i) => {
    if (!TOPIC_ID.test(c.id)) out.push({ path: `categories.${i}.id`, message: "Use letras minúsculas, números e hífen (ex.: ciencia)." });
    else if (seen.has(c.id)) out.push({ path: `categories.${i}.id`, message: `O id "${c.id}" está repetido.` });
    seen.add(c.id);
    if (!c.label.trim()) out.push({ path: `categories.${i}.label`, message: "Campo obrigatório." });
    if (!c.prompts.length) out.push({ path: `categories.${i}.prompts`, message: "Adicione pelo menos um prompt." });
    c.prompts.forEach((p, j) => {
      if (!p.trim()) out.push({ path: `categories.${i}.prompts.${j}`, message: "O prompt não pode ficar vazio." });
    });
  });
  return out;
}

/** "História Antiga" -> "historia-antiga" */
export function slugify(label: string): string {
  return label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/* ---------- edge-tts deltas: "+5%" / "-2Hz" <-> numbers ---------- */
export const parseDelta = (s: string | undefined): number => {
  const m = /^([+-]\d+)/.exec(s ?? "");
  return m ? Number(m[1]) : 0;
};
export const formatDelta = (n: number, unit: "%" | "Hz"): string => `${n >= 0 ? "+" : "-"}${Math.abs(Math.round(n))}${unit}`;
