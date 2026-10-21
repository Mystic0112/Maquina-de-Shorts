import { contentTokens } from "./recentTopics.js";

// pt-BR text helpers shared by the script validators (02/02b) and the caption builder (05).

/** Lowercase, strip accents and anything that is not a letter/digit. "Ninguém," -> "ninguem". */
export function normalizeToken(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** Lowercase letters/digits keeping accents, so "é" (verb) and "e" (conjunction) stay different. */
export function lexicalKey(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

const words = (list: string): string[] => list.split(/\s+/).filter(Boolean);

export const ARTICLES = new Set(words("o a os as um uma uns umas"));

export const PREPOSITIONS = new Set(
  words(
    "de do da dos das em no na nos nas num numa nuns numas por pelo pela pelos pelas para pra pro pras pros " +
      "ao aos à às com sem sob sobre entre até desde contra após perante dum duma dentre",
  ),
);

export const CONJUNCTIONS = new Set(words("e ou mas que se nem porque pois como quando onde enquanto porém embora caso"));

/** Determiners that announce a noun ("O SEU" / "CARRO" reads as broken). */
const DETERMINERS = new Set(
  words("seu sua seus suas meu minha meus minhas nosso nossa nossos nossas teu tua cada esse essa esses essas este esta estes estas aquele aquela aqueles aquelas outro outra outros outras"),
);

export const PRONOUNS = new Set(
  words(
    "eu tu ele ela nós vós eles elas você vocês me te lhe lhes mim ti si comigo contigo conosco isso isto aquilo " +
      "quem qual quais cujo cuja algo alguém ninguém tudo nada todos todas dele dela deles delas nele nela neles nelas",
  ),
);

/** Copulas, auxiliaries and filler adverbs: spoken, but never the key word of a line. */
const WEAK_WORDS = new Set(
  words(
    "é são era eram foi foram ser estar está estão estava estavam tem têm tinha tinham ter há havia vai vão ia iam " +
      "pode podem podia seria seriam fica ficou também então ainda já lá aqui ali assim bem tão muito muita muitos muitas " +
      "mais menos só apenas aí cá sim",
  ),
);

/** A caption cue must not end on one of these (it belongs with the next word). */
export function isDanglingWord(word: string): boolean {
  const key = lexicalKey(word);
  return ARTICLES.has(key) || PREPOSITIONS.has(key) || CONJUNCTIONS.has(key) || DETERMINERS.has(key);
}

/** Content word worth highlighting: nouns, numbers, names, key verbs/adjectives (not function words). */
export function isEmphasisWord(word: string): boolean {
  const key = lexicalKey(word);
  if (!key) return false;
  if (/\p{N}/u.test(key)) return true;
  if (ARTICLES.has(key) || PREPOSITIONS.has(key) || CONJUNCTIONS.has(key) || DETERMINERS.has(key)) return false;
  if (PRONOUNS.has(key) || WEAK_WORDS.has(key)) return false;
  return key.length >= 2 || key === "à";
}

// ---------------------------------------------------------------------------------------------
// Title key terms
// ---------------------------------------------------------------------------------------------

/** Curiosity/framing words of a title that the narration does not need to say. */
const TITLE_FILLER = new Set(
  words(
    "realmente explica explicado explicada entenda descubra saiba ciencia bizarro bizarra estranho estranha chocante " +
      "impressionante insano insana absurdo absurda inacreditavel assustador assustadora sinistro sinistra epico epica " +
      "poucos sabem conhece conhecem acontece aconteceu verdadeiro verdadeira explicacao motivo razao jeito coisa coisas " +
      "tres duas dois",
  ),
);

/** Function words (accent-free), on top of recentTopics' stopwords. */
const FUNCTION_WORDS = new Set(
  [...ARTICLES, ...PREPOSITIONS, ...CONJUNCTIONS, ...DETERMINERS, ...PRONOUNS, ...WEAK_WORDS].map(normalizeToken).concat(
    words("cujo cuja cujos cujas durante dentro fora alem algum alguma alguns algumas nenhum nenhuma tanto tanta tantos tantas apos sob"),
  ),
);

/** Distinctive words of a title (accent-free, light plural stemming) the hook and narration must echo. */
export function titleKeyTokens(title: string): string[] {
  return [...contentTokens(title)].filter((t) => !TITLE_FILLER.has(t) && !FUNCTION_WORDS.has(t));
}

function stem(token: string): string {
  return token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token;
}

/** Same word modulo plural/inflection ("diamante"/"diamantes", "gira"/"girar", "dura"/"durou"). */
export function sameWord(a: string, b: string): boolean {
  const x = stem(a);
  const y = stem(b);
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= 4 && long.startsWith(short) && long.length - short.length <= 3) return true;
  // Verb inflections share a stem but differ in the ending ("dura"/"durou", "chove"/"chuva" stays different).
  return short.length >= 4 && long.length - short.length <= 2 && short.slice(0, -1) === long.slice(0, short.length - 1);
}

/** Accent-free tokens of a text, in order (digits kept). */
export function textTokens(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export interface TokenSpan {
  token: string;
  /** [start, end) char offsets of the word in the text given to `tokenSpans`. */
  start: number;
  end: number;
}

/** `textTokens` plus where each word sits in `text` (pass NFC text so offsets map to what you slice). */
export function tokenSpans(text: string): TokenSpan[] {
  const spans: TokenSpan[] = [];
  for (const m of text.matchAll(/[\p{L}\p{M}\p{N}]+/gu)) {
    const token = normalizeToken(m[0]);
    if (token) spans.push({ token, start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

export function containsWord(tokens: readonly string[], key: string): boolean {
  return tokens.some((t) => sameWord(t, key));
}

const SMALL_NUMBERS = words(
  "zero um dois tres quatro cinco seis sete oito nove dez onze doze treze quatorze quinze dezesseis dezessete dezoito dezenove vinte",
);
const TENS: Record<string, string> = { "30": "trinta", "40": "quarenta", "50": "cinquenta", "60": "sessenta", "70": "setenta", "80": "oitenta", "90": "noventa", "100": "cem", "1000": "mil" };

/** "7" -> "sete" (0-20, round tens, 100, 1000); other tokens unchanged. Lets "SÓ 7 PRESOS" match "sete". */
export function spellNumber(token: string): string {
  if (!/^\d+$/.test(token)) return token;
  const n = Number(token);
  return SMALL_NUMBERS[n] ?? TENS[token] ?? token;
}
