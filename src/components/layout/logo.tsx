"use client";

import Image from "next/image";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

export function Logo({ size = 28, className = "" }: { size?: number; className?: string }) {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

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
