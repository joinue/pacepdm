"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Search, Lock } from "lucide-react";

interface SearchResult {
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
  folder: { path: string };
  versions: { fileSize: number }[];
}

const lifecycleColors: Record<string, string> = {
  WIP: "bg-yellow-100 text-yellow-800",
  "In Review": "bg-blue-100 text-blue-800",
  Released: "bg-green-100 text-green-800",
  Obsolete: "bg-red-100 text-red-800",
};

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [state, setState] = useState("all");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setSearched(true);

    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (category !== "all") params.set("category", category);
    if (state !== "all") params.set("state", state);

    try {
      const res = await fetch(`/api/search?${params}`);
      const data = await res.json();
      setResults(Array.isArray(data) ? data : []);
    } catch {
      setResults([]);
    }
    setLoading(false);
  }

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Search</h2>

      <form onSubmit={handleSearch} className="flex gap-3 items-end">
        <div className="flex-1">
          <Input
            placeholder="Search by filename, part number, or description..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Select value={category} onValueChange={(v) => setCategory(v ?? "all")}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            <SelectItem value="PART">Part</SelectItem>
            <SelectItem value="ASSEMBLY">Assembly</SelectItem>
            <SelectItem value="DRAWING">Drawing</SelectItem>
            <SelectItem value="DOCUMENT">Document</SelectItem>
            <SelectItem value="PURCHASED">Purchased</SelectItem>
          </SelectContent>
        </Select>
        <Select value={state} onValueChange={(v) => setState(v ?? "all")}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="State" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All States</SelectItem>
            <SelectItem value="WIP">WIP</SelectItem>
            <SelectItem value="In Review">In Review</SelectItem>
            <SelectItem value="Released">Released</SelectItem>
            <SelectItem value="Obsolete">Obsolete</SelectItem>
          </SelectContent>
        </Select>
        <Button type="submit" disabled={loading}>
          <Search className="w-4 h-4 mr-2" />
          {loading ? "Searching..." : "Search"}
        </Button>
      </form>

      {searched && (
        <div className="border rounded-lg bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Part Number</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Modified</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center py-8 text-muted-foreground"
                  >
                    No files found matching your search.
                  </TableCell>
                </TableRow>
              ) : (
                results.map((file) => (
                  <TableRow key={file.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-1">
                        {file.name}
                        {file.isCheckedOut && (
                          <Lock className="w-3 h-3 text-red-500" />
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{file.partNumber || "—"}</TableCell>
                    <TableCell>{file.category}</TableCell>
                    <TableCell>v{file.currentVersion}</TableCell>
                    <TableCell>
                      <Badge
                        variant="secondary"
                        className={lifecycleColors[file.lifecycleState] || ""}
                      >
                        {file.lifecycleState}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {file.folder.path}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(file.updatedAt).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
