import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { flattenTaxonomy } from './taxonomy-v1-catalog.mjs';

const target = resolve(process.argv[2] || 'supabase/migrations/20260909184059_canonical_taxonomy_draft_token_evidence.sql');
const stop = new Set(['general','system','systems','disease','diseases','disorder','disorders','principles','clinical','medicine','surgery','pathology','physiology','pharmacology','microbiology','anatomy','pediatric','pediatrics','diagnosis','treatment','management','assessment','infection','infections','imaging','emergencies','emergency','injuries','injury','therapy','disorders']);
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const rows = flattenTaxonomy();
const rules = new Map();
for (const row of rows.filter((item) => ['system','topic','subtopic'].includes(item.type))) {
  const full = row.name.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  if (full.length >= 8) rules.set(`${row.code}|${full}`, { code: row.code, phrase: full, weight: row.type === 'subtopic' ? 5 : 4, basis: `canonical ${row.type} phrase` });
  for (const token of full.split(/\s+/)) {
    if (token.length < 7 || stop.has(token)) continue;
    rules.set(`${row.code}|${token}`, { code: row.code, phrase: token, weight: row.type === 'subtopic' ? 2 : 1, basis: `distinctive canonical ${row.type} term` });
  }
}
const values = [...rules.values()].map((r)=>`(${quote(r.code)},${quote(r.phrase)},${r.weight},${quote(r.basis)})`).join(',\n');
const sql = `-- Transparent term evidence for the read-only v1 classification dry run.
-- This does not create canonical questions or question-taxonomy assignments.
create temporary table qbank_taxonomy_v1_term_rules(stable_code text,match_phrase text,evidence_weight smallint,evidence_basis text) on commit drop;
insert into qbank_taxonomy_v1_term_rules values
${values};
insert into public.canonical_taxonomy_draft_rules(taxonomy_version_id,taxonomy_node_id,match_phrase,evidence_weight,evidence_basis)
select n.taxonomy_version_id,n.id,r.match_phrase,r.evidence_weight,r.evidence_basis
from qbank_taxonomy_v1_term_rules r
join public.canonical_taxonomy_versions v on v.version_key='canonical-medical-v1' and v.status='draft'
join public.canonical_taxonomy_nodes n on n.taxonomy_version_id=v.id and n.stable_code=r.stable_code
on conflict (taxonomy_version_id,taxonomy_node_id,match_phrase) do update set
 evidence_weight=greatest(public.canonical_taxonomy_draft_rules.evidence_weight,excluded.evidence_weight),
 evidence_basis=excluded.evidence_basis,enabled=true;
`;
writeFileSync(target,sql);
console.log(JSON.stringify({target,rules:rules.size},null,2));
