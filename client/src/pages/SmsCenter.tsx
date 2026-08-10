import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { MessageSquare, CheckCircle2, XCircle } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

const COMMANDS = ["BALANCE", "STATUS", "TOKEN_LAST", "OUTAGE", "HELP", "UNKNOWN"] as const;

function SmsTable({ entries, showUser }: { entries: any[]; showUser?: boolean }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Received</TableHead>
          <TableHead>Phone</TableHead>
          {showUser && <TableHead>User</TableHead>}
          <TableHead>Message</TableHead>
          <TableHead>Command</TableHead>
          <TableHead>Reply sent</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((e: any) => (
          <TableRow key={e.id}>
            <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
              {new Date(e.createdAt).toLocaleString()}
            </TableCell>
            <TableCell className="text-sm">{e.phoneNumber}</TableCell>
            {showUser && (
              <TableCell className="text-sm">
                {e.userId != null ? `#${e.userId}` : <span className="text-muted-foreground">unresolved</span>}
              </TableCell>
            )}
            <TableCell className="text-sm max-w-56 truncate" title={e.rawText}>
              {e.rawText}
            </TableCell>
            <TableCell>
              <Badge variant={e.parsedCommand === "UNKNOWN" ? "secondary" : "outline"}>
                {e.parsedCommand}
              </Badge>
            </TableCell>
            <TableCell>
              {e.replySent ? (
                <span className="flex items-center gap-1 text-sm text-green-700 dark:text-green-400">
                  <CheckCircle2 className="h-3 w-3" /> yes
                </span>
              ) : (
                <span className="flex items-center gap-1 text-sm text-muted-foreground" title={e.replyError ?? undefined}>
                  <XCircle className="h-3 w-3" /> no{e.replyError ? ` — ${e.replyError}` : ""}
                </span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function SmsCenter() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const myLog = trpc.smsCommands.getMySmsLog.useQuery({ limit: 50 });

  const [cmdFilter, setCmdFilter] = useState<string>("");
  const [phoneFilter, setPhoneFilter] = useState("");
  const adminLog = trpc.smsCommands.listCommands.useQuery(
    {
      limit: 200,
      parsedCommand: (cmdFilter || undefined) as (typeof COMMANDS)[number] | undefined,
      phoneNumber: phoneFilter || undefined,
    },
    { enabled: isAdmin }
  );

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">SMS Command Center</h1>
          <p className="text-muted-foreground">
            Inbound SMS commands (BALANCE, STATUS, TOKEN_LAST, OUTAGE, HELP) and their replies.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <MessageSquare className="h-4 w-4" /> My SMS log
            </CardTitle>
            <CardDescription>Commands received from your phone number(s)</CardDescription>
          </CardHeader>
          <CardContent>
            {myLog.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : myLog.error ? (
              <p className="text-sm text-muted-foreground">{myLog.error.message}</p>
            ) : !myLog.data || myLog.data.entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No SMS commands received from your number yet. Send BALANCE, STATUS, TOKEN_LAST, OUTAGE or
                HELP to the service number.
              </p>
            ) : (
              <SmsTable entries={myLog.data.entries} />
            )}
          </CardContent>
        </Card>

        {isAdmin && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">All commands (admin)</CardTitle>
              <CardDescription>Platform-wide inbound SMS with resolution status</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-end gap-3 flex-wrap">
                <div className="space-y-2">
                  <Label>Command filter</Label>
                  <Select value={cmdFilter || "all"} onValueChange={(v) => setCmdFilter(v === "all" ? "" : v)}>
                    <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      {COMMANDS.map((c) => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phoneFilter">Phone filter</Label>
                  <Input
                    id="phoneFilter"
                    value={phoneFilter}
                    onChange={(e) => setPhoneFilter(e.target.value)}
                    placeholder="e.g. 2547…"
                    className="w-48"
                  />
                </div>
              </div>
              {adminLog.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : adminLog.error ? (
                <p className="text-sm text-muted-foreground">{adminLog.error.message}</p>
              ) : !adminLog.data || adminLog.data.entries.length === 0 ? (
                <p className="text-sm text-muted-foreground">No SMS commands match the filters.</p>
              ) : (
                <SmsTable entries={adminLog.data.entries} showUser />
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
