import { prisma } from "@/lib/prisma";
import { getCurrentTenantUser } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function LifecyclePage() {
  const tenantUser = await getCurrentTenantUser();

  const lifecycles = await prisma.lifecycle.findMany({
    where: { tenantId: tenantUser.tenantId },
    include: {
      states: { orderBy: { sortOrder: "asc" } },
      transitions: {
        include: {
          fromState: { select: { name: true } },
          toState: { select: { name: true } },
        },
      },
    },
  });

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Lifecycle Management</h2>

      {lifecycles.map((lc) => (
        <Card key={lc.id}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {lc.name}
              {lc.isDefault && <Badge variant="secondary">Default</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm font-medium text-muted-foreground mb-2">
                States
              </p>
              <div className="flex gap-2 flex-wrap">
                {lc.states.map((state) => (
                  <Badge
                    key={state.id}
                    style={{ backgroundColor: state.color + "20", color: state.color, borderColor: state.color }}
                    variant="outline"
                  >
                    {state.name}
                    {state.isInitial && " (Initial)"}
                    {state.isFinal && " (Final)"}
                  </Badge>
                ))}
              </div>
            </div>

            <div>
              <p className="text-sm font-medium text-muted-foreground mb-2">
                Transitions
              </p>
              <div className="space-y-1">
                {lc.transitions.map((t) => (
                  <div key={t.id} className="text-sm flex items-center gap-2">
                    <span>{t.fromState.name}</span>
                    <span className="text-muted-foreground">&rarr;</span>
                    <span>{t.toState.name}</span>
                    <span className="text-muted-foreground">
                      ({t.name})
                    </span>
                    {t.requiresApproval && (
                      <Badge variant="outline" className="text-xs">
                        Requires Approval
                      </Badge>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
