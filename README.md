# Brand Intelligence Agent

Slack-native RAG ai agent for multi-entity brand knowledge.

## Core behavior

Slack message -> conversation context -> query planning -> scoped retrieval -> grounded answer.

The knowledge layer classifies every ingested document by scope, ownership, document type, authority, status, and entity. Retrieval applies the scope and entity as hard filters before ranking.

## Knowledge scopes

- `company` — internal organization knowledge, SOPs, policies, processes, internal strategy, internal operations.
- `client_brand` — a client's own brand truth such as brand books, guidelines, approved strategy, identity, messaging, products, and services.
- `client_project` — work for a client/project that is not permanent brand truth.
- `campaign` — campaign or activation-specific material.
- `external_research` — third-party research, competitor material, market/trend references.
- `conversation` — Slack, email, chat, and meeting discussion/history.
- `unknown` — insufficient evidence to determine scope.

The classifier uses source path, title, metadata, and document content together. A brand/client name by itself is not enough to make a document `client_brand`. Ambiguous documents are retained with low confidence and can be marked for review.

## Document ingestion

Supported directly through Google Drive:
- Google Docs
- Google Sheets
- Google Slides
- text/JSON/XML files

PDF, PPT, and PPTX are supported through the local `officeparser` implementation in `lib/document-parser.js`, with optional OCR and page/slide markers. `DOCUMENT_PARSER_URL` can still be used when parsing is deployed as a separate service.

## Supabase migration

Run migrations in order:

1. `supabase/migrations/001_init.sql`
2. `supabase/migrations/002_slack_conversation_memory.sql`
3. `supabase/migrations/003_semantic_context.sql`
4. `supabase/migrations/004_classification_review_queue.sql`
5. `supabase/migrations/005_hybrid_retrieval.sql`
6. `supabase/migrations/006_source_locations.sql`
7. `supabase/migrations/007_cross_scope_retrieval.sql`
8. `supabase/migrations/008_visual_brand_context.sql`
9. `supabase/migrations/009_visual_page_evidence.sql`
10. `supabase/migrations/010_versioning_entity_resolution.sql`
11. `supabase/migrations/011_change_intelligence.sql`
12. `supabase/migrations/012_change_intelligence_indexes.sql`

Existing rows are intentionally left with `knowledge_scope = 'unknown'` until they are re-ingested and classified from source evidence.

## Visual brand intelligence

PDF, PPT, PPTX, and Google Slides are rendered as complete page/slide images in addition to extracting text and embedded visual assets. Vision analysis can capture composition, hierarchy, spacing, logo placement, alignment, colors, typography, and imagery style. Set `VISION_ENABLED=false` to disable it. `VISION_MAX_PAGES=0
VISION_PAGE_CONCURRENCY=3` analyzes all rendered pages; a positive value caps pages for cost/runtime control.

The local renderer requires `pdftoppm` (Poppler) for PDF rasterization and `soffice` or `libreoffice` for PPT/PPTX conversion. These system dependencies must be present in the deployment environment for full-page rendering.

## Environment

Use `.env.example` and configure the normal application secrets plus:

`DOCUMENT_PARSER_URL` — optional external parser endpoint; local parsing is used when it is not set.\n\n`DOCUMENT_PARSER_OCR=true` — enable OCR during local office-document parsing when supported.

`DEFAULT_BRAND_ID` is optional; the value is deployment configuration and is not a hardcoded real-world organization or client identifier.

## Scope isolation examples

A query for a client's brand guidelines routes to `client_brand`. An internal process question routes to `company`. A campaign question routes to `campaign`. An explicit question about what was discussed routes to `conversation`.

The retrieval function will not return a `company` document for a `client_brand` query, or a `client_brand` document for a `company` query, simply because their text contains the same keywords.

## Security

- Slack requests are HMAC-verified.
- Supabase service-role credentials remain server-side.
- Ingest and debug endpoints require `ADMIN_SECRET`.
- No public Supabase RLS policies are created by the application.

## Classification review

Low-confidence or unknown classifications are persisted in `classification_review_queue`. Admins can inspect pending items with `GET /api/classification/review?brandId=...` and approve or reject them with the protected `POST /api/classification/review` endpoint. Approval updates every chunk from that source so retrieval uses the reviewed metadata consistently.

Existing `unknown` chunks are seeded into the queue by migration `004_classification_review_queue.sql` rather than being silently trusted.

## Evaluation

Run `npm run eval` with `EVAL_BRAND_ID` (or `DEFAULT_BRAND_ID`) configured. The suite checks query routing for company/client/campaign/research scopes and can be extended with answer-level assertions.

## Next milestones

1. Add a review UI on top of the classification review endpoint.
2. Add richer Drive links and page/slide citations.
3. Add stronger vision/OCR workflows for image-heavy documents.
4. Add automated regression evaluation against a real approved knowledge corpus.

### Page-level visual evidence
Rendered PDF/PPT/PPTX pages and Google Slides are analyzed individually. Retrieval preserves matching page/slide evidence on the corresponding text chunks, so answers can ground visual claims to locations such as `page 3` or `slide 7` instead of relying only on an aggregate document summary. Migration 009 adds the `visual_pages` JSONB field.

Approved classification decisions are preserved across Google Drive re-syncs; a scheduled sync will not reset an already approved document back to pending review.

### Document versioning and entity resolution
Documents are grouped by normalized source path/title. When a newer version arrives, older matching versions are marked superseded and excluded from normal retrieval. Historical queries can explicitly opt into superseded material. Semantic classification also stores entity aliases so client references can resolve across canonical names and known aliases.
