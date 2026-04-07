import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentTenantUser } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    const tenantUser = await getCurrentTenantUser();
    const { searchParams } = new URL(request.url);
    const query = searchParams.get("q") || "";
    const category = searchParams.get("category") || "";
    const state = searchParams.get("state") || "";

    if (!query && !category && !state) {
      return NextResponse.json([]);
    }

    const files = await prisma.file.findMany({
      where: {
        tenantId: tenantUser.tenantId,
        AND: [
          query
            ? {
                OR: [
                  { name: { contains: query, mode: "insensitive" } },
                  { partNumber: { contains: query, mode: "insensitive" } },
                  { description: { contains: query, mode: "insensitive" } },
                ],
              }
            : {},
          category ? { category: category as never } : {},
          state ? { lifecycleState: state } : {},
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: 100,
      include: {
        folder: { select: { path: true } },
        checkedOutBy: { select: { fullName: true } },
        versions: {
          orderBy: { version: "desc" },
          take: 1,
          select: { fileSize: true },
        },
      },
    });

    return NextResponse.json(files);
  } catch {
    return NextResponse.json(
      { error: "Search failed" },
      { status: 500 }
    );
  }
}
