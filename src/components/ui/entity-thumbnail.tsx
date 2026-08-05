"use client";

import React, { useRef } from "react";
import { Building2, Cpu, ImageIcon, Layers, Upload, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The picture that sits at the start of a row.
 *
 * Parts, BOMs, and vendors all show one, and before this component each call
 * site re-derived the same `<img className="w-8 h-8 rounded object-cover" />`
 * plus a hand-rolled fallback tile. Three copies meant three different corner
 * radii and three different placeholder icons for the same idea.
 *
 * Two components live here:
 *
 *   `EntityThumbnail` — read-only. Use it in lists and detail headers.
 *   `ThumbnailPicker` — the same tile, clickable, with a hover overlay and a
 *                       remove affordance. Presentational: it hands the chosen
 *                       `File` back and lets the caller decide when to upload
 *                       (immediately for an entity that exists, on save for one
 *                       being created).
 *
 * `next/image` is deliberately not used. Every source here is a Supabase signed
 * URL with a 300-second expiry on an arbitrary storage host, so the optimizer
 * has nothing to cache and would need a remote-pattern allowlist for a host
 * that rotates its query string on every read.
 */

export type ThumbnailKind = "part" | "bom" | "vendor" | "generic";

export type ThumbnailSize = "xs" | "sm" | "md" | "lg";

/** Tile geometry per size. Kept on the spacing scale — no arbitrary pixels. */
const SIZE_CLASSES: Record<ThumbnailSize, { box: string; icon: string; radius: string }> = {
  xs: { box: "w-6 h-6", icon: "w-3 h-3", radius: "rounded" },
  sm: { box: "w-8 h-8", icon: "w-3.5 h-3.5", radius: "rounded" },
  md: { box: "w-14 h-14", icon: "w-5 h-5", radius: "rounded-lg" },
  lg: { box: "w-16 h-16", icon: "w-5 h-5", radius: "rounded-lg" },
};

/**
 * The fallback icon says what the row *is*, so an empty tile still carries
 * information rather than reading as a broken image.
 */
const KIND_ICONS: Record<ThumbnailKind, React.ComponentType<{ className?: string }>> = {
  part: Cpu,
  bom: Layers,
  vendor: Building2,
  generic: ImageIcon,
};

interface EntityThumbnailProps {
  /** Signed URL from the API, or null when the entity has no picture. */
  src?: string | null;
  /** Chooses the placeholder icon. */
  kind?: ThumbnailKind;
  size?: ThumbnailSize;
  /**
   * Alt text. Defaults to empty: in a list the adjacent name already names the
   * row, so an alt would be read out twice. Pass one when the tile stands alone.
   */
  alt?: string;
  /** Layout only (margin/width). Do not restyle the tile from a call site. */
  className?: string;
}

export function EntityThumbnail({
  src,
  kind = "generic",
  size = "sm",
  alt = "",
  className,
}: EntityThumbnailProps) {
  const { box, icon, radius } = SIZE_CLASSES[size];
  const Icon = KIND_ICONS[kind];

  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- signed URL, see note above
      <img
        src={src}
        alt={alt}
        className={cn(box, radius, "object-cover border border-border/60 bg-muted", className)}
      />
    );
  }

  return (
    <div
      aria-hidden={alt ? undefined : true}
      role={alt ? "img" : undefined}
      aria-label={alt || undefined}
      className={cn(
        box,
        radius,
        "shrink-0 bg-muted border border-border/60 flex items-center justify-center",
        className
      )}
    >
      <Icon className={cn(icon, "text-muted-foreground/40")} />
    </div>
  );
}

interface ThumbnailPickerProps extends Omit<EntityThumbnailProps, "alt"> {
  /** Called with the chosen image. The caller owns the upload. */
  onSelect: (file: File) => void;
  /** Called when the user clears the picture. Omit to hide the clear button. */
  onRemove?: () => void;
  /** When false the tile renders read-only (no permission, or a frozen record). */
  disabled?: boolean;
  /** Accessible name for the control, e.g. "Change BOM image". */
  label: string;
  /** Shown while an upload is in flight. */
  busy?: boolean;
}

export function ThumbnailPicker({
  src,
  kind = "generic",
  size = "lg",
  className,
  onSelect,
  onRemove,
  disabled = false,
  label,
  busy = false,
}: ThumbnailPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { radius, icon } = SIZE_CLASSES[size];

  if (disabled) {
    return <EntityThumbnail src={src} kind={kind} size={size} className={className} />;
  }

  return (
    <div className={cn("relative shrink-0 group", className)}>
      <button
        type="button"
        aria-label={label}
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        className={cn(
          radius,
          "block cursor-pointer disabled:cursor-wait",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        )}
      >
        <EntityThumbnail src={src} kind={kind} size={size} />
        <span
          className={cn(
            radius,
            "absolute inset-0 flex items-center justify-center bg-foreground/60 text-background",
            "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100",
            busy && "opacity-100"
          )}
        >
          <Upload className={cn(icon, busy && "animate-pulse")} aria-hidden="true" />
        </span>
      </button>

      {src && onRemove && !busy && (
        <button
          type="button"
          aria-label={`Remove image (${label})`}
          onClick={onRemove}
          className={cn(
            "absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full border border-border",
            "bg-background text-muted-foreground hover:text-destructive",
            "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100",
            "flex items-center justify-center"
          )}
        >
          <X className="w-3 h-3" aria-hidden="true" />
        </button>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset first: picking the same file twice in a row must still fire.
          e.target.value = "";
          if (file) onSelect(file);
        }}
      />
    </div>
  );
}
