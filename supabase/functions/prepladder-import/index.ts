import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const bytesFromBase64 = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authorization = request.headers.get("Authorization") || "";
    const userClient = createClient(url, anon, { global: { headers: { Authorization: authorization } } });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return json({ error: "Authentication required" }, 401);

    const service = createClient(url, serviceKey, { auth: { persistSession: false } });
    const allowed = await service.from("qbank_import_admins").select("user_id").eq("user_id", user.id).maybeSingle();
    if (allowed.error || !allowed.data) return json({ error: "Importer access denied" }, 403);

    const input = await request.json();
    if (input.action === "stage") {
      const path = String(input.path || ""); const expected = String(input.sha256 || "");
      if (!/^prepladder\/anaesthesia\/[a-zA-Z0-9_./-]+\.json\.gz$/.test(path)) return json({ error: "Pilot path rejected" }, 400);
      const content = bytesFromBase64(String(input.content_base64 || ""));
      if (!content.length || content.length > 10 * 1024 * 1024) return json({ error: "Payload size rejected" }, 400);
      const actual = hex(await crypto.subtle.digest("SHA-256", content));
      if (actual !== expected) return json({ error: "Checksum mismatch" }, 400);
      const existing = await service.storage.from("qbank-payloads").download(path);
      if (!existing.error) {
        const existingHash = hex(await crypto.subtle.digest("SHA-256", await existing.data.arrayBuffer()));
        if (existingHash !== expected) return json({ error: "Existing object conflict" }, 409);
        return json({ status: "reused", path, sha256: actual, bytes: content.length });
      }
      const uploaded = await service.storage.from("qbank-payloads").upload(path, content, { contentType: "application/gzip", upsert: false, cacheControl: "31536000" });
      if (uploaded.error) return json({ error: uploaded.error.message }, 500);
      const verified = await service.storage.from("qbank-payloads").download(path);
      if (verified.error || hex(await crypto.subtle.digest("SHA-256", await verified.data.arrayBuffer())) !== expected) {
        await service.storage.from("qbank-payloads").remove([path]);
        return json({ error: "Post-upload verification failed" }, 500);
      }
      return json({ status: "staged", path, sha256: actual, bytes: content.length });
    }
    if (input.action === "commit") {
      const manifest = input.manifest || {};
      if (manifest.platform !== "PrepLadder" || manifest.subject !== "Anaesthesia") return json({ error: "Pilot scope rejected" }, 400);
      const begun = await service.rpc("qbank_begin_prepladder_import", { p_manifest: Object.fromEntries(Object.entries(manifest).filter(([key]) => !["source_tests", "versions", "occurrences", "objects"].includes(key))) });
      if (begun.error) return json({ error: begun.error.message }, 500);
      const committed = await service.rpc("qbank_commit_prepladder_import", { p_manifest: manifest });
      if (committed.error) return json({ error: committed.error.message }, 500);
      return json({ status: "committed", run_id: begun.data, result: committed.data });
    }
    if (input.action === "cleanup") {
      const paths = (input.paths || []).map(String).filter((path: string) => /^prepladder\/anaesthesia\/[a-zA-Z0-9_./-]+\.json\.gz$/.test(path));
      if (!paths.length) return json({ status: "nothing_to_clean" });
      const protectedRows = await service.from("qbank_payload_objects").select("object_path").in("object_path", paths).eq("status", "committed");
      const protectedPaths = new Set((protectedRows.data || []).map((row) => row.object_path));
      const removable = paths.filter((path: string) => !protectedPaths.has(path));
      const removed = removable.length ? await service.storage.from("qbank-payloads").remove(removable) : { error: null };
      if (removed.error) return json({ error: removed.error.message }, 500);
      return json({ status: "cleaned", removed: removable.length });
    }
    return json({ error: "Unsupported action" }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
