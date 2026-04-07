"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function OnboardingPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/40">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle>Welcome to PACE PDM</CardTitle>
        </CardHeader>
        <CardContent className="text-center text-muted-foreground">
          <p>
            Your account is not associated with a workspace yet. Please contact
            your administrator to get added to a workspace, or create a new one
            by registering.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
