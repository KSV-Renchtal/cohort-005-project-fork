import { useEffect, useState } from "react";
import { Link, useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import type { Route } from "./+types/team";
import { getCurrentUserId } from "~/lib/session";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { BookOpen, Copy, Check, AlertTriangle, Lock } from "lucide-react";
import { data, isRouteErrorResponse } from "react-router";
import { db } from "~/db";
import { teams, teamMembers, TeamMemberRole } from "~/db/schema";
import { eq, and } from "drizzle-orm";
import {
  listTeamLicences,
  refundReasonSchema,
  requestTeamLicenceRefund,
} from "~/lib/refunds.server";
import { parseFormData, refusalAsFormError } from "~/lib/validation";
import { listTeamSeats, type SeatStatus } from "~/lib/seats.server";
import { formatPrice } from "~/lib/utils";

function getTeamForAdmin(userId: number) {
  const membership = db
    .select()
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.userId, userId),
        eq(teamMembers.role, TeamMemberRole.Admin)
      )
    )
    .get();

  if (!membership) return undefined;

  return db.select().from(teams).where(eq(teams.id, membership.teamId)).get();
}

export function meta() {
  return [
    { title: "Team — Cadence" },
    { name: "description", content: "Manage your team's course seats" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel.", { status: 401 });
  }

  const team = getTeamForAdmin(currentUserId);

  if (!team) {
    throw data("You don't have a team. Purchase team seats to create one.", {
      status: 404,
    });
  }

  const { courseStats, seats } = listTeamSeats(db, team.id);
  const licences = listTeamLicences(db, team.id);

  return { courseStats, seats, licences };
}

const teamLicenceRefundSchema = refundReasonSchema.extend({
  purchaseId: z.coerce.number().int().positive(),
});

export async function action({ request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel.", { status: 401 });
  }

  const parsed = parseFormData(await request.formData(), teamLicenceRefundSchema);

  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  requestTeamLicenceRefund(db, { userId: currentUserId, ...parsed.data });

  return { errors: null };
}

// requestTeamLicenceRefund throws when a refund rule blocks the request; show
// the rule's message next to the form instead of replacing the team page.
export async function clientAction({ serverAction }: Route.ClientActionArgs) {
  return refusalAsFormError(serverAction);
}

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    const url = `${window.location.origin}/redeem/${code}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10 transition-colors"
      title="Copy redemption link"
    >
      {copied ? (
        <>
          <Check className="size-3" />
          Copied
        </>
      ) : (
        <>
          <Copy className="size-3" />
          Copy link
        </>
      )}
    </button>
  );
}

function SeatStatusBadge({
  status,
  claimedByEmail,
}: {
  status: SeatStatus;
  claimedByEmail: string | null;
}) {
  switch (status) {
    case "claimed":
      return (
        <span className="text-muted-foreground">
          Claimed by {claimedByEmail ?? "a former learner"}
        </span>
      );
    case "void":
      return (
        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          Void
        </span>
      );
    case "locked":
      return (
        <span
          className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
          title="Locked while this Team Licence has an Open Refund Request"
        >
          <Lock className="size-3" />
          Locked
        </span>
      );
    case "unclaimed":
      return (
        <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
          Unclaimed
        </span>
      );
  }
}

function TeamLicenceRefund({
  purchaseId,
  amount,
  lastDayInWindow,
}: {
  purchaseId: number;
  amount: number;
  lastDayInWindow: string;
}) {
  const fetcher = useFetcher<typeof clientAction>();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    const firstError = Object.values(fetcher.data.errors ?? {})[0];
    if (firstError) {
      toast.error(firstError);
    } else {
      toast.success("Refund requested.");
    }
  }, [fetcher.state, fetcher.data]);

  if (!isFormOpen) {
    return (
      <Button variant="outline" size="sm" onClick={() => setIsFormOpen(true)}>
        Request a refund
      </Button>
    );
  }

  return (
    <fetcher.Form method="post" className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Refunds the full {formatPrice(amount)} and ends every seat of this
        licence. You can ask until {lastDayInWindow}.
      </p>
      <input type="hidden" name="purchaseId" value={purchaseId} />
      <Textarea name="reason" rows={3} required placeholder="What went wrong?" />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={isSubmitting}>
          {isSubmitting ? "Sending..." : "Request a refund"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setIsFormOpen(false)}
        >
          Keep it
        </Button>
      </div>
    </fetcher.Form>
  );
}

export default function Team({ loaderData }: Route.ComponentProps) {
  const { courseStats, seats, licences } = loaderData;
  const [courseFilter, setCourseFilter] = useState<number | "all">("all");

  const filteredSeats =
    courseFilter === "all"
      ? seats
      : seats.filter((seat) => seat.courseId === courseFilter);

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Team</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Team Management</h1>
        <p className="mt-1 text-muted-foreground">
          Manage your team&apos;s course seats and coupon codes
        </p>
      </div>

      {/* Per-course stats */}
      {courseStats.length > 0 && (
        <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {courseStats.map((stat) => (
            <Card key={stat.courseId}>
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <BookOpen className="size-4 text-muted-foreground" />
                  <h3 className="font-semibold truncate">{stat.courseTitle}</h3>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-2xl font-bold">
                      {stat.claimedSeats}
                      <span className="text-base font-normal text-muted-foreground">
                        {" "}
                        / {stat.totalSeats}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      seats claimed
                    </p>
                  </div>
                  <Link to={`/courses/${stat.courseSlug}/purchase?mode=team`}>
                    <Button variant="outline" size="sm">
                      Buy more seats
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Team Licences */}
      {licences.length > 0 && (
        <div className="mb-8">
          <h2 className="mb-4 text-lg font-semibold">Team Licences</h2>
          <div className="space-y-3">
            {licences.map((licence) => (
              <Card key={licence.purchaseId}>
                <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="font-medium">{licence.courseTitle}</p>
                    <p className="text-xs text-muted-foreground">
                      {licence.totalSeats} seats ·{" "}
                      {formatPrice(licence.amountPaid)} · bought{" "}
                      {new Date(licence.purchasedAt).toLocaleDateString()}
                    </p>
                    {licence.latestRefundRequest && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Refund request: {licence.latestRefundRequest.status}
                      </p>
                    )}
                  </div>
                  <div className="sm:max-w-sm">
                    {licence.refundOffer ? (
                      <TeamLicenceRefund
                        purchaseId={licence.purchaseId}
                        amount={licence.amountPaid}
                        lastDayInWindow={licence.refundOffer.lastDayInWindow}
                      />
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {licence.refundBlockedBecause}
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Coupon list */}
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Coupons</h2>
          {courseStats.length > 1 && (
            <select
              value={courseFilter}
              onChange={(e) =>
                setCourseFilter(
                  e.target.value === "all" ? "all" : Number(e.target.value)
                )
              }
              className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            >
              <option value="all">All courses</option>
              {courseStats.map((stat) => (
                <option key={stat.courseId} value={stat.courseId}>
                  {stat.courseTitle}
                </option>
              ))}
            </select>
          )}
        </div>

        {filteredSeats.length === 0 ? (
          <p className="text-sm text-muted-foreground">No coupons yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium">Code</th>
                  <th className="px-4 py-3 text-left font-medium">Course</th>
                  <th className="px-4 py-3 text-left font-medium">Status</th>
                  <th className="px-4 py-3 text-left font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredSeats.map((seat) => (
                  <tr key={seat.id} className="border-b last:border-0">
                    <td className="px-4 py-3">
                      <code className="rounded bg-muted px-2 py-0.5 text-xs">
                        {seat.code}
                      </code>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {seat.courseTitle}
                    </td>
                    <td className="px-4 py-3">
                      <SeatStatusBadge
                        status={seat.status}
                        claimedByEmail={seat.claimedByEmail}
                      />
                    </td>
                    <td className="px-4 py-3">
                      {seat.status === "unclaimed" && (
                        <CopyButton code={seat.code} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 404) {
      title = "No team found";
      message =
        typeof error.data === "string"
          ? error.data
          : "You don't have a team yet.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <div className="flex items-center justify-center gap-3">
          <Link to="/">
            <Button>Go Home</Button>
          </Link>
          <Link to="/courses">
            <Button variant="outline">Browse Courses</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
