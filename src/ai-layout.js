// AI-powered layout and semantic schema modularization:
// 1. Local AI semantic clustering (lexical tokenization + FK community detection) — 100% offline, zero API key required.
// 2. Google Gemini API semantic analysis (identifies enterprise business domains and module layout via LLM).

import { measureTable } from './renderer.js';

const DOMAIN_PALETTES = [
  { name: 'blue', hex: '#3b82f6', label: 'Auth & Identity' },
  { name: 'emerald', hex: '#10b981', label: 'Orders & Sales' },
  { name: 'purple', hex: '#8b5cf6', label: 'Catalog & Products' },
  { name: 'amber', hex: '#f59e0b', label: 'Billing & Finance' },
  { name: 'rose', hex: '#f43f5e', label: 'Customer & CRM' },
  { name: 'cyan', hex: '#06b6d4', label: 'System & Analytics' },
];

/**
 * Tokenize a table name into lowercase semantic words (supports snake_case, camelCase, kebab-case).
 */
export function tokenizeName(name) {
  if (!name) return [];
  return String(name)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-\.]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 1 && !/^\d+$/.test(w))
    .map(w => {
      if (w.endsWith('ies')) return w.slice(0, -3) + 'y';
      if (w.endsWith('es') && !w.endsWith('ses')) return w.slice(0, -2);
      if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
      return w;
    });
}

/**
 * Compute semantic keyword similarity between two tables.
 */
function lexicalSimilarity(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0;
  const setA = new Set(tokensA);
  let intersection = 0;
  for (const t of tokensB) {
    if (setA.has(t)) intersection++;
  }
  const union = new Set([...tokensA, ...tokensB]).size;
  return union > 0 ? intersection / union : 0;
}

/**
 * Local AI: Cluster tables into business domains using lexical similarity and FK graph connectivity.
 */
export function clusterTablesLocalAI(model) {
  const tables = model.tables || [];
  if (!tables.length) return [];

  const tableMap = new Map(tables.map(t => [t.key.toLowerCase(), t]));
  const tokensMap = new Map(tables.map(t => [t.key.toLowerCase(), tokenizeName(t.name || t.key)]));

  // Adjacency and connection counts
  const adj = new Map();
  for (const t of tables) adj.set(t.key.toLowerCase(), new Set());

  for (const r of (model.relations || [])) {
    const f = r.fromTable.toLowerCase(), t = r.toTable.toLowerCase();
    if (f !== t && adj.has(f) && adj.has(t)) {
      adj.get(f).add(t);
      adj.get(t).add(f);
    }
  }

  // Initial clusters: each table is its own cluster
  let clusters = tables.map(t => ({
    id: t.key.toLowerCase(),
    tables: [t.key.toLowerCase()],
    tokens: tokensMap.get(t.key.toLowerCase()) || [],
  }));

  // Target cluster count: 2 to 6 domains depending on table count
  const targetClusters = Math.max(1, Math.min(6, Math.ceil(tables.length / 4)));

  // Agglomerative clustering: merge most cohesive pair until target cluster count is reached
  while (clusters.length > targetClusters) {
    let bestScore = -1;
    let bestPair = null;

    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const c1 = clusters[i];
        const c2 = clusters[j];

        // 1. FK connectivity between clusters
        let fkLinks = 0;
        for (const t1 of c1.tables) {
          for (const t2 of c2.tables) {
            if (adj.get(t1)?.has(t2)) fkLinks++;
          }
        }
        const maxPossibleLinks = c1.tables.length * c2.tables.length;
        const linkScore = fkLinks / Math.max(1, maxPossibleLinks);

        // 2. Lexical keyword similarity
        const lexScore = lexicalSimilarity(c1.tokens, c2.tokens);

        // Combined score: heavily weight FKs + naming semantics
        const score = linkScore * 2.5 + lexScore * 1.5;

        if (score > bestScore) {
          bestScore = score;
          bestPair = [i, j];
        }
      }
    }

    if (!bestPair || bestScore <= 0.05) break; // Clusters are distinct enough

    const [i, j] = bestPair;
    const c1 = clusters[i];
    const c2 = clusters[j];

    const merged = {
      id: c1.id + '_' + c2.id,
      tables: [...c1.tables, ...c2.tables],
      tokens: [...new Set([...c1.tokens, ...c2.tokens])],
    };

    clusters.splice(j, 1);
    clusters.splice(i, 1, merged);
  }

  // Generate domain name and color for each cluster
  return clusters.map((c, idx) => {
    // Find most common tokens to name the domain
    const freq = {};
    for (const t of c.tokens) freq[t] = (freq[t] || 0) + 1;
    const sortedTokens = Object.entries(freq).sort((a, b) => b[1] - a[1]).map(e => e[0]);

    let domainName = 'Module ' + (idx + 1);
    if (sortedTokens.length >= 2) {
      domainName = capitalize(sortedTokens[0]) + ' & ' + capitalize(sortedTokens[1]);
    } else if (sortedTokens.length === 1) {
      domainName = capitalize(sortedTokens[0]) + ' Domain';
    } else if (c.tables.length === 1) {
      domainName = capitalize(c.tables[0]);
    }

    const palette = DOMAIN_PALETTES[idx % DOMAIN_PALETTES.length];

    return {
      name: domainName,
      color: palette.name,
      hex: palette.hex,
      tables: c.tables,
    };
  });
}

function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Apply semantic domain layout to model tables.
 * Arranges domains in clean 2D grid cells with ample corridors,
 * and arranges tables within each domain cluster in a compact, readable formation.
 */
export function applySemanticDomainLayout(model, domains, createGroups = true) {
  const tableMap = new Map(model.tables.map(t => [t.key.toLowerCase(), t]));

  // Measure all tables
  for (const t of model.tables) {
    const dims = measureTable(t);
    t.w = dims.w; t.h = dims.h; t.rowH = dims.rowH; t.headerH = dims.headerH;
  }

  const cols = Math.max(1, Math.ceil(Math.sqrt(domains.length)));
  let currentY = 80;
  let rowMaxHeight = 0;
  let currentX = 80;

  const generatedAnnotations = [];

  for (let dIdx = 0; dIdx < domains.length; dIdx++) {
    const domain = domains[dIdx];
    const dCol = dIdx % cols;
    if (dCol === 0 && dIdx > 0) {
      currentY += rowMaxHeight + 120;
      currentX = 80;
      rowMaxHeight = 0;
    }

    const dTables = domain.tables.map(k => tableMap.get(k)).filter(Boolean);
    if (!dTables.length) continue;

    // Arrange tables within this domain in a tidy 2-column or 3-column block
    const subCols = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(dTables.length))));
    let subX = currentX + 30;
    let subY = currentY + 50;
    let subRowMaxH = 0;
    let domainMaxW = 0;

    for (let i = 0; i < dTables.length; i++) {
      const t = dTables[i];
      if (i > 0 && i % subCols === 0) {
        subY += subRowMaxH + 36;
        subX = currentX + 30;
        subRowMaxH = 0;
      }
      t.x = subX;
      t.y = subY;
      subX += t.w + 48;
      subRowMaxH = Math.max(subRowMaxH, t.h);
      domainMaxW = Math.max(domainMaxW, subX - currentX);
    }

    const domainW = Math.max(260, domainMaxW + 20);
    const domainH = Math.max(180, (subY + subRowMaxH) - currentY + 30);
    rowMaxHeight = Math.max(rowMaxHeight, domainH);

    if (createGroups) {
      generatedAnnotations.push({
        id: 'group_ai_' + dIdx + '_' + Date.now().toString(36),
        type: 'group',
        text: domain.name,
        color: domain.color || 'blue',
        tables: domain.tables,
        x: currentX,
        y: currentY,
        w: domainW,
        h: domainH,
      });
    }

    currentX += domainW + 80;
  }

  return { domains, annotations: generatedAnnotations };
}

/**
 * Query Gemini ModelService to find the best available Flash model that supports generateContent.
 */
async function findSupportedGeminiModel(cleanKey) {
  try {
    const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(cleanKey)}`;
    const res = await fetch(listUrl);
    if (res.ok) {
      const data = await res.json();
      const models = data?.models || [];
      // Strictly filter for Flash models that support generateContent (Pro models have 0 quota on free tier)
      const flashModels = models.filter(m =>
        Array.isArray(m.supportedGenerationMethods) &&
        m.supportedGenerationMethods.includes('generateContent') &&
        m.name?.includes('flash')
      );
      if (flashModels.length) {
        const preferred = flashModels.find(m => m.name?.includes('gemini-2.0-flash')) ||
                          flashModels.find(m => m.name?.includes('gemini-1.5-flash-8b')) ||
                          flashModels.find(m => m.name?.includes('gemini-1.5-flash-latest')) ||
                          flashModels.find(m => m.name?.includes('gemini-1.5-flash')) ||
                          flashModels[0];
        return preferred.name.replace(/^models\//, '');
      }
    }
  } catch {
    // Network or restricted key: fallback to static candidate list
  }
  return null;
}

/**
 * Robustly parse JSON from Gemini, handling markdown code fences.
 */
function extractJSON(rawText) {
  if (!rawText) return null;
  const trimmed = rawText.trim();
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const jsonStr = codeBlockMatch ? codeBlockMatch[1] : trimmed;
  try {
    return JSON.parse(jsonStr);
  } catch {
    const start = jsonStr.indexOf('{');
    const end = jsonStr.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(jsonStr.substring(start, end + 1));
    }
    throw new Error('No valid JSON object found in Gemini response.');
  }
}

/**
 * Execute reordering with Google Gemini API.
 */
export async function reorderWithGemini(model, apiKey, options = {}) {
  const cleanKey = apiKey ? apiKey.trim() : '';
  if (!cleanKey) {
    throw new Error('Gemini API Key is required. Please provide a key or choose Local AI.');
  }

  const schemaSummary = {
    tables: model.tables.map(t => ({
      name: t.name || t.key,
      columns: (t.columns || []).map(c => c.name),
    })),
    relations: (model.relations || []).map(r => ({
      from: r.fromTable,
      to: r.toTable,
      fromCol: r.fromCols?.[0],
      toCol: r.toCols?.[0],
    })),
  };

  const prompt = `You are an expert database architect. Analyze this database schema and organize its tables into cohesive business domains (e.g. "Users & Authentication", "Billing & Payments", "Products & Inventory", "Orders & Shipping").

Database Schema:
${JSON.stringify(schemaSummary, null, 2)}

Respond with ONLY a valid JSON object matching this schema:
{
  "domains": [
    {
      "name": "Domain Title",
      "color": "blue | emerald | purple | amber | rose | cyan",
      "tables": ["table1", "table2"]
    }
  ]
}
Include every single table from the schema. Do not omit any tables.`;

  // 1. Discover available Flash model or use high-quota Flash candidate sequence (never Pro models first)
  const discoveredModel = await findSupportedGeminiModel(cleanKey);
  const modelsToTry = [
    ...(discoveredModel ? [discoveredModel] : []),
    'gemini-2.0-flash',
    'gemini-1.5-flash-8b',
    'gemini-1.5-flash',
    'gemini-1.5-flash-latest',
    'gemini-1.5-flash-001',
    'gemini-1.5-flash-002',
  ];

  let lastError = null;
  let rawText = null;

  for (const modelName of [...new Set(modelsToTry)]) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(cleanKey)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
          },
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        const msg = errJson?.error?.message || (await res.text().catch(() => res.statusText));
        lastError = new Error(`Gemini API (${modelName} ${res.status}): ${msg}`);
        // If 404 (model not found) or 429 (rate/quota limit on this model), try next Flash candidate!
        if (res.status === 404 || res.status === 429) continue;
        throw lastError; // Stop on invalid key (400, 401, 403)
      }

      const data = await res.json();
      rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (rawText) break;
    } catch (e) {
      lastError = e;
      if (e.message?.includes('404') || e.message?.includes('429')) continue;
      throw e;
    }
  }

  if (!rawText) {
    // If Gemini quota is exceeded on all models or unavailable, fallback automatically to Local AI
    console.warn('Gemini quota reached on free tier. Gracefully falling back to Local AI:', lastError?.message);
    const localResult = reorderWithLocalAI(model, options);
    return {
      ...localResult,
      fallbackToLocal: true,
      originalError: lastError?.message || 'Quota exceeded (429)',
    };
  }

  const parsed = extractJSON(rawText);
  if (!parsed.domains || !Array.isArray(parsed.domains)) {
    throw new Error('Invalid JSON structure returned by Gemini.');
  }

  // Validate tables: map case-insensitively to exact table keys
  const validKeys = new Map(model.tables.map(t => [t.key.toLowerCase(), t.key]));
  const seen = new Set();

  const domains = parsed.domains.map(d => {
    const mappedTables = (d.tables || [])
      .map(k => validKeys.get(String(k).toLowerCase()))
      .filter(k => k && !seen.has(k));
    for (const k of mappedTables) seen.add(k);
    return {
      name: d.name || 'Domain',
      color: d.color || 'blue',
      tables: mappedTables,
    };
  }).filter(d => d.tables.length > 0);

  // Add any omitted tables to an "Other / General" domain
  const omitted = model.tables.filter(t => !seen.has(t.key)).map(t => t.key);
  if (omitted.length) {
    domains.push({
      name: 'General',
      color: 'cyan',
      tables: omitted,
    });
  }

  return applySemanticDomainLayout(model, domains, options.createGroups !== false);
}

/**
 * Execute reordering with Local Semantic AI (zero network, zero API key).
 */
export function reorderWithLocalAI(model, options = {}) {
  const domains = clusterTablesLocalAI(model);
  return applySemanticDomainLayout(model, domains, options.createGroups !== false);
}
