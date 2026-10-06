import { supabase } from './db.js';

// The brand for a question comes from the question itself (or the thread it sits in),
// never from the channel and never from a default. If it isn't clear, the caller asks.

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Brands the agent may talk about. Paused/archived brands are never matched.
export async function loadBrands(db = supabase()) {
  const { data, error } = await db
    .from('brands')
    .select('id,name,aliases,status')
    .in('status', ['active', 'onboarding']);
  if (error) throw new Error(`Unable to load brands: ${error.message}`);
  return data || [];
}

function namesFor(brand) {
  // A short id like "se" or "qp" is a common word fragment, so only longer ids count; the
  // display name and aliases cover the short forms.
  const names = [brand.name, ...(brand.aliases || [])];
  if (String(brand.id).length > 3) names.push(brand.id);
  return [...new Set(names.filter(Boolean))];
}

function matchesName(text, name) {
  // Words and spaces/hyphens inside a name are interchangeable ("Corner House" = "corner-house").
  const body = String(name).trim().split(/[\s_-]+/).map(escapeRegExp).join('[\\s_-]*');
  // Very short names (QP, SE, ASC, CH) must be written as given, so "se" in ordinary text doesn't count.
  const flags = String(name).length <= 3 ? '' : 'i';
  return new RegExp(`(?<![\\w])${body}(?![\\w])`, flags).test(text);
}

// Brand ids named in a piece of text, in the order the brands are listed.
export function findBrandIds(text, brands) {
  const value = String(text || '');
  if (!value) return [];
  return brands.filter((brand) => namesFor(brand).some((name) => matchesName(value, name))).map((brand) => brand.id);
}

// threadTexts: earlier messages from people in the same thread, newest first.
// The latest message wins; the thread is only consulted when the message names no brand.
export function resolveBrand({ text, threadTexts = [], brands }) {
  const named = findBrandIds(text, brands);
  if (named.length === 1) return { status: 'resolved', brandId: named[0], via: 'message' };
  if (named.length > 1) return { status: 'multiple', brandIds: named };

  for (const earlier of threadTexts) {
    const fromThread = findBrandIds(earlier, brands);
    if (fromThread.length === 1) return { status: 'resolved', brandId: fromThread[0], via: 'thread' };
  }
  return { status: 'none' };
}
