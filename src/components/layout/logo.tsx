"use client";

import Image from "next/image";
import { useTheme } from "next-themes";
import { useHasMounted } from "@/hooks/use-has-mounted";

export function Logo({ size = 28, className = "" }: { size?: number; className?: string }) {
  const { resolvedTheme } = useTheme();
  const mounted = useHasMounted();

  if (!mounted) {
    return <div style={{ width: size, height: size }} className={className} />;
  }

  return (
    <Image
      src={resolvedTheme === "dark" ? "/images/ppdm-logo-white.png" : "/images/ppdm-logo.png"}
      alt="PACE PDM"
      width={size}
      height={size}
      className={className}
    />
  );
}
