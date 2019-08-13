import abbreviation, { CSSAbbreviation, CSSProperty, CSSValue, Literal, Value, Field } from '@emmetio/css-abbreviation';
import { Config, SnippetsMap } from '../config';
import createSnippet, { CSSSnippet, nest, getKeywords, CSSSnippetType, CSSSnippetRaw, CSSSnippetProperty, CSSKeywordRef } from './snippets';
import calculateScore from './score';

type MatchInput = CSSSnippet | CSSKeywordRef | string;

/**
 * Parses given Emmet abbreviation into a final abbreviation tree with all
 * required transformations applied
 */
export default function parse(abbr: string | CSSAbbreviation, config: Config, snippets = convertSnippets(config.snippets)): CSSAbbreviation {
    if (typeof abbr === 'string') {
        abbr = abbreviation(abbr);
    }

    for (const node of abbr) {
        resolveNode(node, snippets, config);
    }

    return abbr;
}

export { default as stringify } from './format';

/**
 * Converts given raw snippets into internal snippets representation
 */
export function convertSnippets(snippets: SnippetsMap): CSSSnippet[] {
    const result: CSSSnippet[] = [];
    for (const key of Object.keys(snippets)) {
        result.push(createSnippet(key, snippets[key]));
    }

    return nest(result);
}

/**
 * Resolves given node: finds matched CSS snippets using fuzzy match and resolves
 * keyword aliases from node value
 */
function resolveNode(node: CSSProperty, snippets: CSSSnippet[], config: Config): CSSProperty {
    if (config.context) {
        // Resolve as value of given CSS property
        const snippet = snippets.find(s => s.type === CSSSnippetType.Property && s.property === config.context) as CSSSnippetProperty | undefined;
        resolveAsPropertyValue(node, config, snippet);
    } else {
        const snippet = findBestMatch(node.name!, snippets, config.options['stylesheet.fuzzySearchMinScore']);

        if (snippet) {
            if (snippet.type === CSSSnippetType.Property) {
                resolveAsProperty(node, snippet, config);
            } else {
                resolveAsSnippet(node, snippet);
            }
        }
    }

    resolveNumericValue(node, config);

    return node;
}

/**
 * Resolves given parsed abbreviation node as CSS property
 */
function resolveAsProperty(node: CSSProperty, snippet: CSSSnippetProperty, config: Config): CSSProperty {
    const abbr = node.name!;
    node.name = snippet.property;

    if (!node.value.length) {
        // No value defined in abbreviation node, try to resolve unmatched part
        // as a keyword alias
        if (!resolveSnippetKeyword(node, getUnmatchedPart(abbr, snippet.key), snippet) && snippet.value.length) {
            const defaultValue = snippet.value[0]!;
            node.value = defaultValue.some(hasField)
                ? defaultValue
                : defaultValue.map(n => wrapWithField(n));
        }
    } else {
        // Replace keyword alias from current abbreviation node with matched keyword
        const kw = getSingleKeyword(node);
        if (kw) {
            resolveSnippetKeyword(node, kw.value, snippet)
                || resolveGlobalKeyword(node, kw.value, config);
        }
    }

    return node;
}

/**
 * Resolves given parsed abbreviation node as a snippet: a plain code chunk
 */
function resolveAsSnippet(node: CSSProperty, snippet: CSSSnippetRaw): CSSProperty {
    return setNodeAsText(node, snippet.value);
}

/**
 * Resolves given parsed abbreviation node as property value of given `snippet`:
 * tries to find best matching keyword from CSS snippet
 */
function resolveAsPropertyValue(node: CSSProperty, config: Config, snippet?: CSSSnippetProperty): CSSProperty {
    const kw = getSingleKeyword(node);
    if (kw) {
        const score = config.options['stylesheet.fuzzySearchMinScore'];
        snippet && resolveSnippetKeyword(node, kw.value, snippet, score)
            || resolveGlobalKeyword(node, kw.value, config, score);
    }
    return node;
}

/**
 * Sets given parsed abbreviation node as a text snippet
 */
function setNodeAsText(node: CSSProperty, text: string): CSSProperty {
    node.name = void 0;
    node.value = [literalValue(text)];
    return node;
}

/**
 * Finds best matching item from `items` array
 * @param abbr  Abbreviation to match
 * @param items List of items for match
 * @param minScore The minimum score the best matched item should have to be a valid match.
 */
export function findBestMatch<T extends MatchInput>(abbr: string, items: T[], minScore = 0): T | null {
    let matchedItem: T | null = null;
    let maxScore = 0;

    for (const item of items) {
        const score = calculateScore(abbr, getScoringPart(item));

        if (score === 1) {
            // direct hit, no need to look further
            return item;
        }

        if (score && score >= maxScore) {
            maxScore = score;
            matchedItem = item;
        }
    }

    return maxScore >= minScore ? matchedItem : null;
}

function getScoringPart(item: MatchInput): string {
    if (typeof item === 'string') {
        return item;
    }
    return (item as CSSKeywordRef).keyword || (item as CSSSnippet).key;
}

/**
 * Returns a part of `abbr` that wasn’t directly matched against `str`.
 * For example, if abbreviation `poas` is matched against `position`,
 * the unmatched part will be `as` since `a` wasn’t found in string stream
 */
function getUnmatchedPart(abbr: string, str: string): string {
    for (let i = 0, lastPos = 0; i < abbr.length; i++) {
        lastPos = str.indexOf(abbr[i], lastPos);
        if (lastPos === -1) {
            return abbr.slice(i);
        }
        lastPos++;
    }

    return '';
}

function resolveSnippetKeyword(node: CSSProperty, kw: string, snippet: CSSSnippetProperty, minScore?: number): boolean {
    const keywords = getKeywords(snippet);
    const ref = findBestMatch(kw, keywords, minScore);

    if (ref) {
        node.value = snippet.value[ref.index]!;
        return true;
    }

    return false;
}

/**
 * Tries to resolve node’s value with matched global keyword from given `kw` alias
 * @returns `true` if value was successfully resolved
 */
function resolveGlobalKeyword(node: CSSProperty, kw: string, config: Config, minScore?: number): boolean {
    const ref = findBestMatch(kw, config.options['stylesheet.keywords'], minScore);
    if (ref) {
        node.value = [literalValue(ref)];
        return true;
    }

    return false;
}

/**
 * Resolves numeric values in given abbreviation node
 */
function resolveNumericValue(node: CSSProperty, config: Config) {
    const aliases = config.options['stylesheet.unitAliases'];
    const unitless = config.options['stylesheet.unitless'];

    for (const v of node.value) {
        for (const t of v.value) {
            if (t.type === 'NumberValue') {
                if (t.unit) {
                    t.unit = aliases[t.unit] || t.unit;
                } else if (t.value !== 0 && !unitless.includes(node.name!)) {
                    // use `px` for integers, `em` for floats
                    // NB: num|0 is a quick alternative to Math.round(0)
                    t.unit = t.value === (t.value | 0)
                        ? config.options['stylesheet.intUnit']
                        : config.options['stylesheet.floatUnit'];
                }
            }
        }
    }
}

/**
 * Returns literal token if it’s a single value of given abbreviation node
 */
function getSingleKeyword(node: CSSProperty): Literal | void {
    if (node.value.length === 1) {
        const value = node.value[0]!;
        if (value.value.length === 1 && value.value[0].type === 'Literal') {
            return value.value[0] as Literal;
        }
    }
}

/**
 * Constructs CSS property value with given literal
 */
function literalValue(value: string): CSSValue {
    return {
        type: 'CSSValue',
        value: [literal(value)]
    };
}

/**
 * Constructs literal token
 */
function literal(value: string): Literal {
    return { type: 'Literal', value };
}

/**
 * Constructs field token
 */
function field(index: number, name: string): Field {
    return { type: 'Field', index, name };
}

/**
 * Check if given value contains fields
 */
function hasField(value: CSSValue): boolean {
    for (const v of value.value) {
        if (v.type === 'Field' || (v.type === 'FunctionCall' && v.arguments.some(hasField))) {
            return true;
        }
    }

    return false;
}

interface WrapState {
    index: number;
}

/**
 * Wraps tokens of given abbreviation with fields
 */
function wrapWithField(node: CSSValue, state: WrapState = { index: 1 }): CSSValue {
    let value: Value[] = [];
    for (const v of node.value) {
        switch (v.type) {
            case 'ColorValue':
                value.push(field(state.index++, v.raw));
                break;
            case 'Literal':
                value.push(field(state.index++, v.value));
                break;
            case 'NumberValue':
                value.push(field(state.index++, `${v.value}${v.unit}`));
                break;
            case 'StringValue':
                const q = v.quote === 'single' ? '\'' : '"';
                value.push(field(state.index++, q + v.value + q));
                break;
            case 'FunctionCall':
                value.push(field(state.index++, v.name), literal('('));
                for (let i = 0, il = v.arguments.length; i < il; i++) {
                    value = value.concat(wrapWithField(v.arguments[i], state).value);
                    if (i !== il - 1) {
                        value.push(literal(', '));
                    }
                }
                value.push(literal(')'));
                break;
            default:
                value.push(v);
        }
    }

    return {...node, value };
}
