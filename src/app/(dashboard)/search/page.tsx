"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Search, Lock, Download, SearchX, FileText, ClipboardList, Cpu, Package,
  X, SlidersHorizontal, Bookmark, BookmarkPlus, ArrowUpDown, Clock,
  SortAsc, Users, FolderOpen, Hash, Tag, ChevronRight,
} from "lucide-react";
import { FormattedDate } from "@/components/ui/formatted-date";
import { EmptyState } from "@/components/ui/empty-state";

// --- Types ---

interface FileResult {
  id: string;
  name: string;
  partNumber: string | null;
  description: string | null;
  category: string;
  currentVersion: number;
  lifecycleState: string;
  isCheckedOut: boolean;
  checkedOutBy: { fullName: string } | null;
  updatedAt: string;
  folderId: string;
  folder: { path: string };
}

interface ECOResult {
  id: string;
  ecoNumber: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  createdAt: string;
  createdBy: { fullName: string } | null;
}

interface PartResult {
  id: string;
  partNumber: string;
  name: string;
  description: string | null;
  category: string;
  lifecycle: string;
  unitCost: number | null;
  updatedAt: string;
}

interface BOMResult {
  id: string;
  name: string;
  description: string | null;
  revision: string;
  status: string;
  updatedAt: string;
}

interface FolderResult {
  id: string;
  name: string;
  path: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SavedSearch {
  id: string;
  name: string;
  filters: { q?: string; type?: string; category?: string; state?: string };
  isShared: boolean;
  userId: string;
}

// --- Variants ---

const lifecycleVariants: Record<string, "warning" | "info" | "success" | "error" | "muted"> = {
  WIP: "warning", "In Review": "info", Released: "success", Obsolete: "error",
};

const ecoStatusVariants: Record<string, "muted" | "info" | "warning" | "success" | "error" | "purple"> = {
  DRAFT: "muted", SUBMITTED: "info", IN_REVIEW: "warning", APPROVED: "success",
  REJECTED: "error", IMPLEMENTED: "purple", CLOSED: "muted",
};

const priorityVariants: Record<string, "muted" | "info" | "orange" | "error"> = {
  LOW: "muted", MEDIUM: "info", HIGH: "orange", CRITICAL: "error",
};

const bomStatusVariants: Record<string, "muted" | "info" | "warning" | "success" | "error"> = {
  DRAFT: "muted", IN_REVIEW: "warning", APPROVED: "info", RELEASED: "success", OBSOLETE: "error",
};

const categoryLabels: Record<string, string> = {
  PART: "Part", ASSEMBLY: "Assembly", DRAWING: "Drawing",
  DOCUMENT: "Document", PURCHASED: "Purchased", OTHER: "Other",
};

// --- Highlight helper ---

function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query.trim() || !text) return <>{text}</>;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <mark key={i} className="bg-primary/20 text-foreground rounded-sm px-0.5">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

// --- Sort options ---

type SortOption = "relevance" | "newest" | "oldest" | "name";

const sortLabels: Record<SortOption, string> = {
  relevance: "Relevance",
  newest: "Newest first",
  oldest: "Oldest first",
  name: "Name A-Z",
};

const sortIcons: Record<SortOption, typeof ArrowUpDown> = {
  relevance: ArrowUpDown,
  newest: Clock,
  oldest: Clock,
  name: SortAsc,
};

function sortResults<T extends { name?: string; title?: string; updatedAt?: string; createdAt?: string }>(
  items: T[],
  sort: SortOption,
): T[] {
  if (sort === "relevance") return items; // API default order
  const sorted = [...items];
  if (sort === "newest" || sort === "oldest") {
    sorted.sort((a, b) => {
      const da = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const db = new Date(b.updatedAt || b.createdAt || 0).getTime();
      return sort === "newest" ? db - da : da - db;
    });
  } else if (sort === "name") {
    sorted.sort((a, b) => (a.name || a.title || "").localeCompare(b.name || b.title || ""));
  }
  return sorted;
}

// --- Component ---

export default function SearchPage() {
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get("q") || "";
  const initialType = searchParams.get("type") || "all";

  const [query, setQuery] = useState(initialQuery);
  const [searchType, setSearchType] = useState(initialType);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [sortBy, setSortBy] = useState<SortOption>("relevance");
  const [showFilters, setShowFilters] = useState(false);
  const [files, setFiles] = useState<FileResult[]>([]);
  const [ecos, setEcos] = useState<ECOResult[]>([]);
  const [parts, setParts] = useState<PartResult[]>([]);
  const [boms, setBoms] = useState<BOMResult[]>([]);
  const [folders, setFolders] = useState<FolderResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saving, setSaving] = useState(false);
  const router = useRouter();
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load saved searches on mount
  useEffect(() => {
    fetch("/api/saved-searches")
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setSavedSearches(data); })
      .catch(() => {});
  }, []);

  const executeSearch = useCallback(async (q: string, type: string, category?: string, state?: string) => {
    if (!q.trim() && !category && !state) return;
    setLoading(true);
    setSearched(true);

    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q);
    if (type !== "all") params.set("type", type);
    if (category) params.set("category", category);
    if (state) params.set("state", state);

    try {
      const res = await fetch(`/api/search?${params}`);
      const data = await res.json();
      setFiles(data.files || []);
      setEcos(data.ecos || []);
      setParts(data.parts || []);
      setBoms(data.boms || []);
      setFolders(data.folders || []);
    } catch {
      setFiles([]); setEcos([]); setParts([]); setBoms([]); setFolders([]);
    }
    setLoading(false);
  }, []);

  // Auto-search on mount with URL params
  useEffect(() => {
    if (initialQuery) {
      setQuery(initialQuery);
      executeSearch(initialQuery, initialType);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery]);

  // Debounced live search
  function handleQueryChange(value: string) {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (value.trim()) {
        router.replace(`/search?q=${encodeURIComponent(value)}${searchType !== "all" ? `&type=${searchType}` : ""}`, { scroll: false });
        executeSearch(value, searchType, categoryFilter, stateFilter);
      }
    }, 350);
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim() && !categoryFilter && !stateFilter) return;
    router.replace(`/search?q=${encodeURIComponent(query)}${searchType !== "all" ? `&type=${searchType}` : ""}`, { scroll: false });
    executeSearch(query, searchType, categoryFilter, stateFilter);
  }

  function handleTabChange(value: string) {
    setSearchType(value);
    if (searched && query.trim()) {
      executeSearch(query, value, categoryFilter, stateFilter);
    }
  }

  function handleFilterChange(category: string, state: string) {
    setCategoryFilter(category);
    setStateFilter(state);
    if (query.trim() || category || state) {
      executeSearch(query, searchType, category, state);
    }
  }

  function clearSearch() {
    setQuery("");
    setFiles([]); setEcos([]); setParts([]); setBoms([]); setFolders([]);
    setSearched(false);
    setCategoryFilter("");
    setStateFilter("");
    inputRef.current?.focus();
  }

  function applySavedSearch(saved: SavedSearch) {
    const f = saved.filters;
    setQuery(f.q || "");
    setSearchType(f.type || "all");
    setCategoryFilter(f.category || "");
    setStateFilter(f.state || "");
    if (f.q || f.category || f.state) {
      executeSearch(f.q || "", f.type || "all", f.category, f.state);
      router.replace(`/search?q=${encodeURIComponent(f.q || "")}`, { scroll: false });
    }
  }

  async function saveCurrentSearch() {
    if (!saveName.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/saved-searches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: saveName,
          filters: { q: query, type: searchType, category: categoryFilter, state: stateFilter },
          isShared: false,
        }),
      });
      const data = await res.json();
      if (data.id) {
        setSavedSearches((prev) => [...prev, data]);
        setShowSaveDialog(false);
        setSaveName("");
      }
    } catch {}
    setSaving(false);
  }

  async function deleteSavedSearch(id: string) {
    try {
      await fetch("/api/saved-searches", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ searchId: id }),
      });
      setSavedSearches((prev) => prev.filter((s) => s.id !== id));
    } catch {}
  }

  async function handleDownload(fileId: string) {
    const res = await fetch(`/api/files/${fileId}/download`);
    const d = await res.json();
    if (d.url) window.open(d.url, "_blank");
  }

  const sortedFiles = sortResults(files, sortBy);
  const sortedEcos = sortResults(ecos, sortBy);
  const sortedParts = sortResults(parts, sortBy);
  const sortedBoms = sortResults(boms, sortBy);
  const sortedFolders = sortResults(folders, sortBy);

  const totalResults = files.length + ecos.length + parts.length + boms.length + folders.length;
  const hasActiveFilters = categoryFilter || stateFilter;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold">Search</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Search across files, folders, ECOs, parts, and BOMs
          </p>
        </div>
        {searched && query.trim() && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs"
            onClick={() => setShowSaveDialog(true)}
          >
            <BookmarkPlus className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Save search</span>
          </Button>
        )}
      </div>

      {/* Saved searches bar */}
      {savedSearches.length > 0 && (
        <div className="flex items-center gap-2 overflow-x-auto pb-1 -mb-2">
          <Bookmark className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          {savedSearches.map((saved) => (
            <div key={saved.id} className="group flex items-center shrink-0">
              <button
                onClick={() => applySavedSearch(saved)}
                className="inline-flex items-center gap-1.5 h-7 px-2.5 text-xs rounded-l-md border border-r-0 border-border/60 bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
              >
                {saved.isShared && <Users className="w-3 h-3" />}
                {saved.name}
              </button>
              <button
                onClick={() => deleteSavedSearch(saved.id)}
                className="inline-flex items-center justify-center h-7 w-6 rounded-r-md border border-border/60 bg-muted/40 text-muted-foreground/50 hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 transition-colors cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Search form */}
      <form onSubmit={handleSearch} className="space-y-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input
              ref={inputRef}
              placeholder="Search by name, part number, or description..."
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              className="pl-8 pr-8"
              autoFocus
            />
            {query && (
              <button
                type="button"
                onClick={clearSearch}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <Button
            type="button"
            variant={showFilters || hasActiveFilters ? "default" : "outline"}
            size="sm"
            className="h-8 gap-1.5 shrink-0"
            onClick={() => setShowFilters(!showFilters)}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Filters</span>
            {hasActiveFilters && (
              <span className="ml-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary-foreground/20 text-[10px] font-bold">
                {(categoryFilter ? 1 : 0) + (stateFilter ? 1 : 0)}
              </span>
            )}
          </Button>
        </div>

        {/* Advanced filters panel */}
        {showFilters && (
          <div className="flex flex-wrap items-center gap-3 p-3 rounded-lg border bg-muted/30 animate-in fade-in-0 slide-in-from-top-1 duration-200">
            <div className="flex items-center gap-2">
              <Tag className="w-3.5 h-3.5 text-muted-foreground" />
              <Select
                value={categoryFilter || "all"}
                onValueChange={(v) => handleFilterChange(!v || v === "all" ? "" : v, stateFilter)}
              >
                <SelectTrigger className="w-36 h-7 text-xs">
                  <SelectValue placeholder="Category">
                    {(v) => v === "all" ? "All categories" : (categoryLabels[v as keyof typeof categoryLabels] ?? "Category")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All categories</SelectItem>
                  {Object.entries(categoryLabels).map(([key, label]) => (
                    <SelectItem key={key} value={key}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Hash className="w-3.5 h-3.5 text-muted-foreground" />
              <Select
                value={stateFilter || "all"}
                onValueChange={(v) => handleFilterChange(categoryFilter, !v || v === "all" ? "" : v)}
              >
                <SelectTrigger className="w-36 h-7 text-xs">
                  <SelectValue placeholder="State">
                    {(v) => v === "all" ? "All states" : (v as string)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All states</SelectItem>
                  <SelectItem value="WIP">WIP</SelectItem>
                  <SelectItem value="In Review">In Review</SelectItem>
                  <SelectItem value="Released">Released</SelectItem>
                  <SelectItem value="Obsolete">Obsolete</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {hasActiveFilters && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground"
                onClick={() => handleFilterChange("", "")}
              >
                <X className="w-3 h-3 mr-1" />
                Clear filters
              </Button>
            )}
          </div>
        )}
      </form>

      {/* Save search dialog */}
      {showSaveDialog && (
        <div className="flex items-center gap-2 p-3 rounded-lg border bg-muted/30 animate-in fade-in-0 slide-in-from-top-1 duration-200">
          <BookmarkPlus className="w-4 h-4 text-muted-foreground shrink-0" />
          <Input
            placeholder="Name this search..."
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            className="h-7 text-xs flex-1"
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveCurrentSearch(); } }}
          />
          <Button size="sm" className="h-7 text-xs" onClick={saveCurrentSearch} disabled={saving || !saveName.trim()}>
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setShowSaveDialog(false); setSaveName(""); }}>
            Cancel
          </Button>
        </div>
      )}

      {/* Results header with count + sort */}
      {searched && !loading && totalResults > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {totalResults} result{totalResults !== 1 ? "s" : ""}
            {query.trim() && <> for <span className="font-medium text-foreground">&ldquo;{query}&rdquo;</span></>}
          </p>
          <Select value={sortBy} onValueChange={(v) => v && setSortBy(v as SortOption)}>
            <SelectTrigger className="w-36 h-7 text-xs gap-1.5">
              {(() => { const Icon = sortIcons[sortBy]; return <Icon className="w-3 h-3" />; })()}
              <SelectValue>{(v) => sortLabels[v as keyof typeof sortLabels] ?? ""}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {Object.entries(sortLabels).map(([key, label]) => (
                <SelectItem key={key} value={key}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 rounded-lg bg-muted/50 animate-pulse" />
          ))}
        </div>
      )}

      {/* Initial empty state */}
      {!searched && !loading && (
        <div className="text-center py-20">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-muted/60 mb-4">
            <Search className="w-6 h-6 text-muted-foreground/40" />
          </div>
          <p className="font-medium text-sm text-muted-foreground">Start searching</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
            Search across files, folders, ECOs, parts, and BOMs by name, part number, or description.
            Use filters to narrow your results.
          </p>
          <div className="flex items-center justify-center gap-4 mt-4 text-xs text-muted-foreground/60">
            <span className="inline-flex items-center gap-1">
              <kbd className="px-1.5 py-0.5 rounded border bg-muted text-[10px] font-mono">Ctrl+K</kbd>
              Quick search
            </span>
            <span className="inline-flex items-center gap-1">
              <kbd className="px-1.5 py-0.5 rounded border bg-muted text-[10px] font-mono">/</kbd>
              Focus search
            </span>
          </div>
        </div>
      )}

      {/* No results state */}
      {searched && totalResults === 0 && !loading && (
        <EmptyState
          icon={SearchX}
          title="No results found"
          description={hasActiveFilters
            ? "Try removing some filters or broadening your search."
            : "Try different keywords or use filters to narrow by category or state."}
          action={hasActiveFilters && (
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={() => handleFilterChange("", "")}
            >
              Clear all filters
            </Button>
          )}
        />
      )}

      {/* Tabbed results */}
      {searched && totalResults > 0 && !loading && (
        <Tabs value={searchType} onValueChange={(v) => v && handleTabChange(v)}>
          <TabsList variant="line" className="w-full justify-start">
            <TabsTrigger value="all">
              All
              <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5 py-0">{totalResults}</Badge>
            </TabsTrigger>
            <TabsTrigger value="files" disabled={files.length === 0 && searchType !== "files"}>
              <FileText className="w-3.5 h-3.5" />
              Files
              {files.length > 0 && <Badge variant="secondary" className="ml-1 text-[10px] px-1.5 py-0">{files.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="ecos" disabled={ecos.length === 0 && searchType !== "ecos"}>
              <ClipboardList className="w-3.5 h-3.5" />
              ECOs
              {ecos.length > 0 && <Badge variant="secondary" className="ml-1 text-[10px] px-1.5 py-0">{ecos.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="parts" disabled={parts.length === 0 && searchType !== "parts"}>
              <Cpu className="w-3.5 h-3.5" />
              Parts
              {parts.length > 0 && <Badge variant="secondary" className="ml-1 text-[10px] px-1.5 py-0">{parts.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="boms" disabled={boms.length === 0 && searchType !== "boms"}>
              <Package className="w-3.5 h-3.5" />
              BOMs
              {boms.length > 0 && <Badge variant="secondary" className="ml-1 text-[10px] px-1.5 py-0">{boms.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="folders" disabled={folders.length === 0 && searchType !== "folders"}>
              <FolderOpen className="w-3.5 h-3.5" />
              Folders
              {folders.length > 0 && <Badge variant="secondary" className="ml-1 text-[10px] px-1.5 py-0">{folders.length}</Badge>}
            </TabsTrigger>
          </TabsList>

          {/* All tab */}
          <TabsContent value="all" className="space-y-5 mt-4">
            {files.length > 0 && <FileResults files={sortedFiles} query={query} onNavigate={router.push} onDownload={handleDownload} />}
            {ecos.length > 0 && <ECOResults ecos={sortedEcos} query={query} onNavigate={router.push} />}
            {parts.length > 0 && <PartResults parts={sortedParts} query={query} onNavigate={router.push} />}
            {boms.length > 0 && <BOMResults boms={sortedBoms} query={query} onNavigate={router.push} />}
            {folders.length > 0 && <FolderResults folders={sortedFolders} query={query} onNavigate={router.push} />}
          </TabsContent>

          {/* Individual tabs */}
          <TabsContent value="files" className="mt-4">
            {files.length > 0
              ? <FileResults files={sortedFiles} query={query} onNavigate={router.push} onDownload={handleDownload} />
              : <EmptyTab type="files" />}
          </TabsContent>
          <TabsContent value="ecos" className="mt-4">
            {ecos.length > 0
              ? <ECOResults ecos={sortedEcos} query={query} onNavigate={router.push} />
              : <EmptyTab type="ECOs" />}
          </TabsContent>
          <TabsContent value="parts" className="mt-4">
            {parts.length > 0
              ? <PartResults parts={sortedParts} query={query} onNavigate={router.push} />
              : <EmptyTab type="parts" />}
          </TabsContent>
          <TabsContent value="boms" className="mt-4">
            {boms.length > 0
              ? <BOMResults boms={sortedBoms} query={query} onNavigate={router.push} />
              : <EmptyTab type="BOMs" />}
          </TabsContent>
          <TabsContent value="folders" className="mt-4">
            {folders.length > 0
              ? <FolderResults folders={sortedFolders} query={query} onNavigate={router.push} />
              : <EmptyTab type="folders" />}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

// --- Empty tab state ---

function EmptyTab({ type }: { type: string }) {
  return (
    <div className="text-center py-12">
      <SearchX className="w-8 h-8 mx-auto mb-2 text-muted-foreground/30" />
      <p className="text-sm text-muted-foreground">No {type} match your search</p>
    </div>
  );
}

// --- Result Section Header ---

function ResultSection({
  icon,
  title,
  count,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        {icon}
        <span>{title}</span>
        <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{count}</Badge>
      </div>
      <div className="border rounded-lg bg-background divide-y divide-border/50">
        {children}
      </div>
    </div>
  );
}

// --- File Results ---

function FileResults({
  files, query, onNavigate, onDownload,
}: {
  files: FileResult[];
  query: string;
  onNavigate: (url: string) => void;
  onDownload: (fileId: string) => void;
}) {
  return (
    <ResultSection icon={<FileText className="w-4 h-4" />} title="Files" count={files.length}>
      {files.map((file) => (
        <div
          key={file.id}
          className="flex items-center justify-between p-3 hover:bg-muted/50 cursor-pointer transition-colors group first:rounded-t-lg last:rounded-b-lg"
          onClick={() => onNavigate(`/vault?folderId=${file.folderId}&fileId=${file.id}`)}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate">
                <HighlightText text={file.name} query={query} />
              </span>
              {file.isCheckedOut && (
                <span className="inline-flex items-center gap-1 text-[10px] text-red-500 shrink-0">
                  <Lock className="w-3 h-3" />
                  {file.checkedOutBy?.fullName}
                </span>
              )}
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">
                v{file.currentVersion}
              </Badge>
            </div>
            <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
              {file.partNumber && (
                <span className="font-mono">
                  <HighlightText text={file.partNumber} query={query} />
                </span>
              )}
              {file.partNumber && <span className="text-border">&middot;</span>}
              <span>{categoryLabels[file.category] || file.category}</span>
              <span className="text-border">&middot;</span>
              <Badge variant={lifecycleVariants[file.lifecycleState] || "muted"} className="text-[10px] px-1.5 py-0">
                {file.lifecycleState}
              </Badge>
              <span className="text-border">&middot;</span>
              <span className="inline-flex items-center gap-1 truncate">
                <FolderOpen className="w-3 h-3 shrink-0" />
                {file.folder?.path}
              </span>
            </div>
            {file.description && (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-1">
                <HighlightText text={file.description} query={query} />
              </p>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0 ml-3">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={(e) => { e.stopPropagation(); onDownload(file.id); }}
            >
              <Download className="w-3.5 h-3.5" />
            </Button>
            <ChevronRight className="w-4 h-4 text-muted-foreground/30 group-hover:text-muted-foreground transition-colors" />
          </div>
        </div>
      ))}
    </ResultSection>
  );
}

// --- ECO Results ---

function ECOResults({
  ecos, query, onNavigate,
}: {
  ecos: ECOResult[];
  query: string;
  onNavigate: (url: string) => void;
}) {
  return (
    <ResultSection icon={<ClipboardList className="w-4 h-4" />} title="Engineering Change Orders" count={ecos.length}>
      {ecos.map((eco) => (
        <div
          key={eco.id}
          className="flex items-center justify-between p-3 hover:bg-muted/50 cursor-pointer transition-colors group first:rounded-t-lg last:rounded-b-lg"
          onClick={() => onNavigate(`/ecos?ecoId=${eco.id}`)}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-muted-foreground">
                <HighlightText text={eco.ecoNumber} query={query} />
              </span>
              <span className="text-sm font-medium truncate">
                <HighlightText text={eco.title} query={query} />
              </span>
            </div>
            <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
              <Badge variant={ecoStatusVariants[eco.status] || "muted"} className="text-[10px] px-1.5 py-0">
                {eco.status.replace("_", " ")}
              </Badge>
              <Badge variant={priorityVariants[eco.priority] || "muted"} className="text-[10px] px-1.5 py-0">
                {eco.priority}
              </Badge>
              {eco.createdBy && (
                <>
                  <span className="text-border">&middot;</span>
                  <span>{eco.createdBy.fullName}</span>
                </>
              )}
              <span className="text-border">&middot;</span>
              <FormattedDate date={eco.createdAt} variant="date" />
            </div>
            {eco.description && (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-1">
                <HighlightText text={eco.description} query={query} />
              </p>
            )}
          </div>
          <ChevronRight className="w-4 h-4 text-muted-foreground/30 group-hover:text-muted-foreground transition-colors shrink-0 ml-3" />
        </div>
      ))}
    </ResultSection>
  );
}

// --- Part Results ---

function PartResults({
  parts, query, onNavigate,
}: {
  parts: PartResult[];
  query: string;
  onNavigate: (url: string) => void;
}) {
  return (
    <ResultSection icon={<Cpu className="w-4 h-4" />} title="Parts" count={parts.length}>
      {parts.map((part) => (
        <div
          key={part.id}
          className="flex items-center justify-between p-3 hover:bg-muted/50 cursor-pointer transition-colors group first:rounded-t-lg last:rounded-b-lg"
          onClick={() => onNavigate(`/parts?partId=${part.id}`)}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-muted-foreground">
                <HighlightText text={part.partNumber} query={query} />
              </span>
              <span className="text-sm font-medium truncate">
                <HighlightText text={part.name} query={query} />
              </span>
            </div>
            <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
              <span>{categoryLabels[part.category] || part.category.replace("_", " ")}</span>
              <span className="text-border">&middot;</span>
              <Badge variant={lifecycleVariants[part.lifecycle] || "muted"} className="text-[10px] px-1.5 py-0">
                {part.lifecycle}
              </Badge>
              {part.unitCost !== null && (
                <>
                  <span className="text-border">&middot;</span>
                  <span className="font-mono">${part.unitCost.toFixed(2)}</span>
                </>
              )}
              <span className="text-border">&middot;</span>
              <FormattedDate date={part.updatedAt} variant="date" />
            </div>
            {part.description && (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-1">
                <HighlightText text={part.description} query={query} />
              </p>
            )}
          </div>
          <ChevronRight className="w-4 h-4 text-muted-foreground/30 group-hover:text-muted-foreground transition-colors shrink-0 ml-3" />
        </div>
      ))}
    </ResultSection>
  );
}

// --- BOM Results ---

function BOMResults({
  boms, query, onNavigate,
}: {
  boms: BOMResult[];
  query: string;
  onNavigate: (url: string) => void;
}) {
  return (
    <ResultSection icon={<Package className="w-4 h-4" />} title="Bills of Materials" count={boms.length}>
      {boms.map((bom) => (
        <div
          key={bom.id}
          className="flex items-center justify-between p-3 hover:bg-muted/50 cursor-pointer transition-colors group first:rounded-t-lg last:rounded-b-lg"
          onClick={() => onNavigate(`/boms?bomId=${bom.id}`)}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate">
                <HighlightText text={bom.name} query={query} />
              </span>
              <span className="text-xs font-mono text-muted-foreground">Rev {bom.revision}</span>
            </div>
            <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
              <Badge variant={bomStatusVariants[bom.status] || "muted"} className="text-[10px] px-1.5 py-0">
                {bom.status}
              </Badge>
              <span className="text-border">&middot;</span>
              <FormattedDate date={bom.updatedAt} variant="date" />
            </div>
            {bom.description && (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-1">
                <HighlightText text={bom.description} query={query} />
              </p>
            )}
          </div>
          <ChevronRight className="w-4 h-4 text-muted-foreground/30 group-hover:text-muted-foreground transition-colors shrink-0 ml-3" />
        </div>
      ))}
    </ResultSection>
  );
}

// --- Folder Results ---

function FolderResults({
  folders, query, onNavigate,
}: {
  folders: FolderResult[];
  query: string;
  onNavigate: (url: string) => void;
}) {
  return (
    <ResultSection icon={<FolderOpen className="w-4 h-4" />} title="Folders" count={folders.length}>
      {folders.map((folder) => (
        <div
          key={folder.id}
          className="flex items-center justify-between p-3 hover:bg-muted/50 cursor-pointer transition-colors group first:rounded-t-lg last:rounded-b-lg"
          onClick={() => onNavigate(`/vault?folderId=${folder.id}`)}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <FolderOpen className="w-4 h-4 text-muted-foreground shrink-0" />
              <span className="text-sm font-medium truncate">
                <HighlightText text={folder.name} query={query} />
              </span>
            </div>
            <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
              <span className="truncate">
                <HighlightText text={folder.path} query={query} />
              </span>
              <span className="text-border">&middot;</span>
              <FormattedDate date={folder.updatedAt} variant="date" />
            </div>
          </div>
          <ChevronRight className="w-4 h-4 text-muted-foreground/30 group-hover:text-muted-foreground transition-colors shrink-0 ml-3" />
        </div>
      ))}
    </ResultSection>
  );
}
