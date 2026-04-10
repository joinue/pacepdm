import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";
import { getFolderAccessScope, filterViewable } from "@/lib/folder-access";

export async function GET(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { searchParams } = new URL(request.url);
    const query = searchParams.get("q") || "";
    const category = searchParams.get("category") || "";
    const state = searchParams.get("state") || "";
    const type = searchParams.get("type") || "all"; // all, files, ecos, parts, boms, folders

    if (!query && !category && !state) {
      return NextResponse.json({ files: [], ecos: [], parts: [], boms: [] });
    }

    const db = getServiceClient();
    // Resolve once per request — files, folders, and (future) other
    // folder-scoped entities all share the same scope. Filtering happens
    // in memory after the raw query because the allowed set can be large
    // and `.in()` with thousands of IDs degrades quickly; this post-filter
    // is bounded by the query's `.limit(50)` ceiling. If this becomes the
    // bottleneck, switch to an RPC that joins inside the DB.
    const scope = await getFolderAccessScope(tenantUser);
    const results: { files?: unknown[]; ecos?: unknown[]; parts?: unknown[]; boms?: unknown[]; folders?: unknown[] } = {};

    // Files search
    if (type === "all" || type === "files") {
      let fileQuery = db
        .from("files")
        .select(`
          *,
          folder:folders!files_folderId_fkey(path),
          checkedOutBy:tenant_users!files_checkedOutById_fkey(fullName)
        `)
        .eq("tenantId", tenantUser.tenantId)
        .order("updatedAt", { ascending: false })
        .limit(50);

      if (query) {
        fileQuery = fileQuery.or(`name.ilike.%${query}%,partNumber.ilike.%${query}%,description.ilike.%${query}%`);
      }
      if (category) {
        fileQuery = fileQuery.eq("category", category);
      }
      if (state) {
        fileQuery = fileQuery.eq("lifecycleState", state);
      }

      const { data: files } = await fileQuery;
      // Strip files whose containing folder the user can't view. Silent drop
      // — no "hidden result" placeholder — so a user can't confirm existence
      // of a file by searching for its name or part number.
      results.files = filterViewable(scope, files || [], (f: { folderId: string }) => f.folderId);
    }

    // ECOs search
    if (type === "all" || type === "ecos") {
      let ecoQuery = db
        .from("ecos")
        .select("*, createdBy:tenant_users!ecos_createdById_fkey(fullName)")
        .eq("tenantId", tenantUser.tenantId)
        .order("createdAt", { ascending: false })
        .limit(50);

      if (query) {
        ecoQuery = ecoQuery.or(`title.ilike.%${query}%,ecoNumber.ilike.%${query}%,description.ilike.%${query}%`);
      }
      if (state) {
        ecoQuery = ecoQuery.eq("status", state);
      }

      const { data: ecos } = await ecoQuery;
      results.ecos = ecos || [];
    }

    // Parts search
    if (type === "all" || type === "parts") {
      let partQuery = db
        .from("parts")
        .select("*")
        .eq("tenantId", tenantUser.tenantId)
        .order("updatedAt", { ascending: false })
        .limit(50);

      if (query) {
        partQuery = partQuery.or(`partNumber.ilike.%${query}%,name.ilike.%${query}%,description.ilike.%${query}%`);
      }
      if (category) {
        partQuery = partQuery.eq("category", category);
      }

      const { data: parts } = await partQuery;
      results.parts = parts || [];
    }

    // BOMs search
    if (type === "all" || type === "boms") {
      let bomQuery = db
        .from("boms")
        .select("*")
        .eq("tenantId", tenantUser.tenantId)
        .order("updatedAt", { ascending: false })
        .limit(50);

      if (query) {
        bomQuery = bomQuery.or(`name.ilike.%${query}%,description.ilike.%${query}%`);
      }

      const { data: boms } = await bomQuery;
      results.boms = boms || [];
    }

    // Folders search
    if (type === "all" || type === "folders") {
      let folderQuery = db
        .from("folders")
        .select("*")
        .eq("tenantId", tenantUser.tenantId)
        .neq("parentId", null) // exclude root folder
        .order("updatedAt", { ascending: false })
        .limit(50);

      if (query) {
        folderQuery = folderQuery.or(`name.ilike.%${query}%,path.ilike.%${query}%`);
      }

      const { data: folders } = await folderQuery;
      results.folders = filterViewable(scope, folders || [], (f: { id: string }) => f.id);
    }

    return NextResponse.json(results);
  } catch {
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}
