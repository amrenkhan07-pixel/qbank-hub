import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "private, no-store" },
});

function publishableKey() {
  const direct = Deno.env.get("SUPABASE_ANON_KEY");
  if (direct) return direct;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "[]");
    return keys.find((item: { disabled?: boolean; key?: string }) => !item.disabled && item.key)?.key || "";
  } catch { return ""; }
}

async function decodeObject(blob: Blob, compression: string | null) {
  if (compression !== "gzip") return JSON.parse(await blob.text());
  const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL") || "";
  const key = publishableKey();
  const authorization = request.headers.get("Authorization") || "";
  if (!url || !key || !authorization) return json({ error: "Authenticated review access is required" }, 401);
  const db = createClient(url, key, { global: { headers: { Authorization: authorization } } });
  const token = authorization.replace(/^Bearer\s+/i, "");
  const { data: auth, error: authError } = await db.auth.getUser(token);
  if (authError || !auth.user) return json({ error: "Authenticated review access is required" }, 401);

  let questionId = "";
  try { questionId = String((await request.json())?.question_id || ""); } catch { return json({ error: "Invalid request" }, 400); }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(questionId)) {
    return json({ error: "A valid question ID is required" }, 400);
  }

  // Keep question bodies lazy and authorize only IDs exposed by the bounded
  // review cohorts. The current 1,000-question batch is intentionally not in
  // the older 380-row draft sample.
  const [batchMembership, legacyMembership] = await Promise.all([
    db.rpc("qbank_canonical_batch_review_page", {
      p_version_key: "canonical-medical-v1", p_page: 1, p_page_size: 25,
      p_subject: null, p_confidence: null, p_review_state: null,
      p_search: questionId, p_unresolved: null, p_negative: null,
      p_content_override: null, p_pyq: null,
    }),
    db.from("canonical_taxonomy_draft_sample")
      .select("question_id").eq("question_id", questionId).limit(1).maybeSingle(),
  ]);
  const inBatch = !batchMembership.error && Number(batchMembership.data?.total || 0) === 1;
  const inLegacySample = !legacyMembership.error && Boolean(legacyMembership.data);
  if (!inBatch && !inLegacySample) return json({ error: "Question is outside the review sample" }, 404);

  const questionResult = await db.from("questions").select(
    "id,question_text,correct_answer,explanation_html,question_images,explanation_images,video_url,audio_url,image_path,source_test_label,source_reference,source_subtopic_label,is_pyq,exam_year,exam_tags,platform_id,subject_id,platforms(name),subjects(name)"
  ).eq("id", questionId).single();
  if (questionResult.error) return json({ error: questionResult.error.message }, 500);
  const question = questionResult.data as Record<string, unknown>;

  const [legacyOptions, occurrence] = await Promise.all([
    db.from("question_options").select("option_key,option_text,is_correct,sort_order")
      .eq("question_id", questionId).order("sort_order"),
    db.from("qbank_source_occurrences").select(
      "question_position,source_question_id,is_pyq,exam_year,exam_session,exam_tags,qbank_source_tests(title,source_test_id,sequence,is_pyq)"
    ).eq("question_id", questionId).eq("is_current", true).order("question_position").limit(1).maybeSingle(),
  ]);
  if (legacyOptions.error) return json({ error: legacyOptions.error.message }, 500);

  let content = {
    stem: String(question.question_text || ""),
    options: (legacyOptions.data || []).map((option) => ({
      key: option.option_key, html: option.option_text, is_correct: option.is_correct,
    })),
    correct_keys: (legacyOptions.data || []).filter((option) => option.is_correct).map((option) => option.option_key),
    explanation: String(question.explanation_html || ""),
    media: [
      ...((question.question_images as unknown[]) || []).map((reference) => ({ placement: "question", reference })),
      ...((question.explanation_images as unknown[]) || []).map((reference) => ({ placement: "explanation", reference })),
    ],
    audio: question.audio_url || null,
    video: question.video_url || null,
  };
  if (!content.correct_keys.length && question.correct_answer) {
    content.correct_keys = String(question.correct_answer).split(",").map((answer) => answer.trim().match(/^([A-Z])(?:\b|[.)])/i)?.[1]?.toUpperCase()).filter(Boolean) as string[];
  }

  if (!content.options.length) {
    const ref = await db.from("qbank_question_payloads").select(
      "payload_index,correct_option_keys,media_status,qbank_payload_objects!inner(bucket_id,object_path,compression)"
    ).eq("question_id", questionId).single();
    if (ref.error) return json({ error: `Question payload is unavailable: ${ref.error.message}` }, 500);
    const object = ref.data.qbank_payload_objects as unknown as { bucket_id: string; object_path: string; compression: string };
    const downloaded = await db.storage.from(object.bucket_id).download(object.object_path);
    if (downloaded.error) return json({ error: `Question payload download failed: ${downloaded.error.message}` }, 500);
    const document = await decodeObject(downloaded.data, object.compression);
    const payload = document?.questions?.[Number(ref.data.payload_index)];
    if (!payload) return json({ error: "Question payload index is invalid" }, 500);
    content = {
      stem: String(payload.question_html || question.question_text || ""),
      options: (payload.options || []).map((option: Record<string, unknown>) => ({
        key: option.key, html: option.html, is_correct: option.is_correct,
      })),
      correct_keys: payload.correct_keys || ref.data.correct_option_keys || [],
      explanation: String(payload.explanation_html || ""),
      media: payload.media || [],
      audio: payload.audio || null,
      video: payload.video || null,
    };
  }

  return json({
    question_id: questionId,
    content,
    source: {
      platform: (question.platforms as { name?: string } | null)?.name || "Unknown",
      subject: (question.subjects as { name?: string } | null)?.name || "Unknown",
      source_test: (occurrence.data?.qbank_source_tests as unknown as { title?: string } | null)?.title || question.source_test_label || "",
      source_question_id: occurrence.data?.source_question_id || "",
      position: occurrence.data?.question_position || null,
      is_pyq: Boolean(occurrence.data?.is_pyq || question.is_pyq),
      exam_year: occurrence.data?.exam_year || question.exam_year || null,
      exam_session: occurrence.data?.exam_session || "",
      exam_tags: occurrence.data?.exam_tags || question.exam_tags || [],
      source_reference: question.source_reference || "",
      source_subtopic_label: question.source_subtopic_label || "",
    },
    media_reference: question.image_path || null,
  });
});
