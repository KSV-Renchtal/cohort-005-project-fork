import { data, isRouteErrorResponse, Link } from "react-router";
import { eq } from "drizzle-orm";
import { AlertTriangle, ReceiptText, UsersRound } from "lucide-react";
import type { Route } from "./+types/admin.refunds";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import { UserRole, users } from "~/db/schema";
import {
  listOpenRefundRequests,
  MAX_WATCHED_SECONDS,
  REFUND_WINDOW_DAYS,
} from "~/lib/admin-refunds.server";
import { formatPrice } from "~/lib/utils";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";

export function meta() {
  return [
    { title: "Refund Requests — Cadence" },
    { name: "description", content: "Open Refund Requests to decide" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to review refunds.", {
      status: 401,
    });
  }

  const currentUser = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();

  if (!currentUser || currentUser.role !== UserRole.Admin) {
    throw data("Only admins can access this page.", { status: 403 });
  }

  return { requests: listOpenRefundRequests(db) };
}

function formatWatchTime(seconds: number) {
  const totalMinutes = Math.floor(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const headerClass =
  "px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground";

export default function AdminRefunds({ loaderData }: Route.ComponentProps) {
  const { requests } = loaderData;

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Refund Requests</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Refund Requests</h1>
        <p className="mt-1 text-muted-foreground">
          Open Refund Requests, oldest first
        </p>
      </div>

      {requests.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <ReceiptText className="mx-auto mb-3 size-8 text-muted-foreground/50" />
            <p className="text-muted-foreground">No open Refund Requests.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className={headerClass}>Asked by</th>
                    <th className={headerClass}>Course</th>
                    <th className={headerClass}>Paid</th>
                    <th className={headerClass}>Purchased</th>
                    <th className={headerClass}>Progress</th>
                    <th className={headerClass}>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((request) => (
                    <tr
                      key={request.id}
                      className="border-b border-border align-top last:border-0"
                    >
                      <td className="px-4 py-3 text-sm font-medium">
                        {request.requesterName}
                      </td>
                      <td className="px-4 py-3 text-sm">{request.courseTitle}</td>
                      <td className="px-4 py-3 text-sm">
                        {formatPrice(request.amountPaid)}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        <div>{formatDate(request.purchasedAt)}</div>
                        <div className="text-xs text-muted-foreground">
                          day {request.dayOfWindow} of {REFUND_WINDOW_DAYS}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {request.progress.kind === "teamLicence" ? (
                          <>
                            <span className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs font-medium">
                              <UsersRound className="size-3" />
                              Team Licence
                            </span>
                            <div className="mt-1">
                              {request.progress.claimedSeats} of{" "}
                              {request.progress.totalSeats} seats claimed
                            </div>
                          </>
                        ) : (
                          <>
                            <div
                              className={
                                request.progress.overWatchLimit
                                  ? "font-medium text-destructive"
                                  : undefined
                              }
                            >
                              {formatWatchTime(request.progress.watchedSeconds)}{" "}
                              watched
                              {request.progress.overWatchLimit && (
                                <span className="ml-1 inline-flex items-center gap-1 text-xs">
                                  <AlertTriangle className="size-3" />
                                  over {MAX_WATCHED_SECONDS / 3600}h
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {request.progress.completedLessons} of{" "}
                              {request.progress.totalLessons} lessons completed
                            </div>
                          </>
                        )}
                      </td>
                      <td className="max-w-sm whitespace-pre-wrap px-4 py-3 text-sm">
                        {request.reason}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading refund requests.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message =
        typeof error.data === "string"
          ? error.data
          : "Only admins can access this page.";
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
        <Link to="/">
          <Button>Go Home</Button>
        </Link>
      </div>
    </div>
  );
}
