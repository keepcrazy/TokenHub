import { Activity, AlertCircle, Check, Copy, Gauge, Search, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { canViewAdminAudit } from "../core/navigation";
import { type AdminUser, type ApiContext, type AppData, type RequestDetail, type RequestLog, type RequestPayloadLog } from "../core/types";
import { apiKeyAuditLabel, projectName, providerAttemptLabel, providerAuditLabel, providerResourceAuditLabel } from "../domain/entities";
import { compactNumber, formatMoney, formatNumber, formatTime } from "../domain/formatting";
import { actionLabel, enumValueLabel, resourceTypeLabel } from "../domain/labels";
import { countWithUnit, routeAttemptCountText, tx } from "../i18n/runtime";
import { adminFetch, isAuthExpiredError } from "../resources/payloads";
import { DataSection, SimpleTable, StatusPill } from "../shared/ui";
import { type PaginationState, PaginationControls } from "./settings-table";

type RequestLogSummary = {
  all: number;
  ok: number;
  error: number;
  average_latency_ms: number;
};

const emptyRequestLogSummary: RequestLogSummary = { all: 0, ok: 0, error: 0, average_latency_ms: 0 };

export function AuditView({ api, data, user }: { api: ApiContext; data: AppData; user: AdminUser }) {
  const [activeAuditTab, setActiveAuditTab] = useState<"requests" | "admin">("requests");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "ok" | "error">("all");
  const [logs, setLogs] = useState<RequestLog[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [summary, setSummary] = useState<RequestLogSummary>(emptyRequestLogSummary);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedRequestID, setSelectedRequestID] = useState("");
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const showAdminAudit = canViewAdminAudit(user);

  useEffect(() => {
    if (!showAdminAudit && activeAuditTab === "admin") {
      setActiveAuditTab("requests");
    }
  }, [activeAuditTab, showAdminAudit]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let active = true;
    let needsPageCorrection = false;
    const params = new URLSearchParams({ page: String(page), page_size: String(pageSize), status: statusFilter });
    const keyword = debouncedQuery.trim();
    if (keyword) params.set("q", keyword);

    setLoading(true);
    setError("");
    setSelectedRequestID("");
    setDetail(null);
    setDetailError("");
    adminFetch(api, `/api/admin/audit/requests?${params.toString()}`)
      .then(async (resp) => {
        if (!resp.ok) throw new Error(`request logs ${resp.status}`);
        return (await resp.json()) as {
          data?: RequestLog[];
          pagination?: { page?: number; page_size?: number; total?: number; total_pages?: number };
          summary?: RequestLogSummary;
        };
      })
      .then((payload) => {
        if (!active) return;
        const nextTotalPages = Math.max(1, payload.pagination?.total_pages ?? 1);
        if (page > nextTotalPages) {
          needsPageCorrection = true;
          setPage(nextTotalPages);
          return;
        }
        setLogs(payload.data ?? []);
        setTotal(payload.pagination?.total ?? 0);
        setTotalPages(nextTotalPages);
        setSummary(payload.summary ?? emptyRequestLogSummary);
      })
      .catch((err) => {
        if (isAuthExpiredError(err) || !active) return;
        setSelectedRequestID("");
        setDetail(null);
        setDetailError("");
        setError(err instanceof Error ? err.message : tx("加载失败"));
      })
      .finally(() => {
        if (active && !needsPageCorrection) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, debouncedQuery, page, pageSize, statusFilter]);

  const safePage = Math.min(page, Math.max(1, totalPages));
  const requestLogPagination: PaginationState = {
    page: safePage,
    pageSize,
    pageCount: Math.max(1, totalPages),
    startIndex: total === 0 ? 0 : (safePage - 1) * pageSize,
    endIndex: Math.min(safePage * pageSize, total),
    setPage: (nextPage) => setPage(Math.min(Math.max(nextPage, 1), Math.max(1, totalPages))),
    setPageSize: (nextPageSize) => {
      setPageSize(nextPageSize);
      setPage(1);
    },
  };

  useEffect(() => {
    if (activeAuditTab !== "requests") return;
    if (loading || error) return;
    if (logs.length === 0) {
      setSelectedRequestID("");
      setDetail(null);
      return;
    }
    const selectedVisible = logs.some((log) => log.request_id === selectedRequestID);
    if (!selectedRequestID || !selectedVisible) {
      setSelectedRequestID(logs[0].request_id);
    }
  }, [activeAuditTab, error, loading, logs, selectedRequestID]);

  useEffect(() => {
    if (activeAuditTab !== "requests") return;
    if (!selectedRequestID) {
      setDetail(null);
      return;
    }
    let alive = true;
    setDetailLoading(true);
    setDetailError("");
    adminFetch(api, `/api/admin/audit/requests/${encodeURIComponent(selectedRequestID)}`)
      .then(async (resp) => {
        if (!resp.ok) throw new Error(`request detail ${resp.status}`);
        return (await resp.json()) as RequestDetail;
      })
      .then((payload) => {
        if (!alive) return;
        setDetail({
          log: payload.log,
          usage: payload.usage ?? [],
          attempts: payload.attempts ?? [],
          payload: payload.payload ?? null,
        });
      })
      .catch((err) => {
        if (isAuthExpiredError(err) || !alive) return;
        setDetail(null);
        setDetailError(err instanceof Error ? err.message : tx("请求详情加载失败"));
      })
      .finally(() => {
        if (alive) setDetailLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [activeAuditTab, api, selectedRequestID]);

  const successRate = summary.all ? Math.round((summary.ok / summary.all) * 100) : 0;
  const averageLatency = Math.round(summary.average_latency_ms);

  const filters = [
    { key: "all", label: `${tx("全部")} ${formatNumber(summary.all)}` },
    { key: "ok", label: `${tx("成功")} ${formatNumber(summary.ok)}` },
    { key: "error", label: `${tx("失败")} ${formatNumber(summary.error)}` },
  ] as const;

  return (
    <div className="audit-view">
      <div className="audit-tabs" role="tablist" aria-label={tx("日志类型")}>
        <button
          type="button"
          className={`audit-tab ${activeAuditTab === "requests" ? "active" : ""}`}
          onClick={() => setActiveAuditTab("requests")}
          role="tab"
          aria-selected={activeAuditTab === "requests"}
        >
          <Activity size={15} />
          <span>{tx("大模型请求历史")}</span>
          <strong>{formatNumber(summary.all)}</strong>
        </button>
        {showAdminAudit ? (
          <button
            type="button"
            className={`audit-tab ${activeAuditTab === "admin" ? "active" : ""}`}
            onClick={() => setActiveAuditTab("admin")}
            role="tab"
            aria-selected={activeAuditTab === "admin"}
          >
            <ShieldCheck size={15} />
            <span>{tx("后台操作审计")}</span>
            <strong>{formatNumber(data.auditEvents.length)}</strong>
          </button>
        ) : null}
      </div>

      {activeAuditTab === "requests" || !showAdminAudit ? (
        <DataSection title="大模型请求历史">
          <div className="request-history">
            <div className="request-history-toolbar">
              <label className="request-search" aria-label={tx("搜索请求历史")}>
                <Search size={15} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={tx("搜索请求 ID、模型、Provider、状态码")}
                />
              </label>
              <div className="request-filter-tabs" role="tablist" aria-label={tx("请求状态筛选")}>
                {filters.map((filter) => (
                  <button
                    key={filter.key}
                    type="button"
                    className={statusFilter === filter.key ? "active" : ""}
                    onClick={() => {
                      setStatusFilter(filter.key);
                      setPage(1);
                    }}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="metrics request-metrics">
              <RequestMetric label="总请求" value={formatNumber(summary.all)} icon={Activity} />
              <RequestMetric label="成功率" value={`${successRate}%`} icon={Check} />
              <RequestMetric label="失败请求" value={formatNumber(summary.error)} icon={AlertCircle} />
              <RequestMetric label="平均延迟" value={`${formatNumber(averageLatency)}ms`} icon={Gauge} />
            </div>

            <div className="request-history-layout">
              <div className="request-list-panel">
                <div className="request-list-head">
                  <span>{tx("请求列表")}</span>
                  <strong>{countWithUnit(total, "条", "record", "件")}</strong>
                </div>
                {loading ? (
                  <div className="compact-empty">{tx("正在加载")}</div>
                ) : error ? (
                  <div className="status-line error">{tx("加载失败")}: {error}</div>
                ) : logs.length === 0 ? (
                  <div className="compact-empty">{tx("没有匹配的请求记录")}</div>
                ) : (
                  <div className="request-list" role="list">
                    {logs.map((log) => (
                      <button
                        key={log.request_id}
                        type="button"
                        className={`request-list-row ${selectedRequestID === log.request_id ? "active" : ""}`}
                        onClick={() => setSelectedRequestID(log.request_id)}
                      >
                        <span className="request-row-main">
                          <strong>{log.model || "-"}</strong>
                          <span>{log.request_id}</span>
                        </span>
                        <span className="request-row-meta">
                          <span>{providerAuditLabel(data, log)}</span>
                          <span>{formatTime(log.created_at)}</span>
                        </span>
                        <span className="request-row-tail">
                          <StatusPill status={log.status_code >= 400 ? "error" : "ok"} label={String(log.status_code || "-")} />
                          <span>{log.latency_ms || 0}ms</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                <PaginationControls pagination={requestLogPagination} totalItems={total} />
              </div>

              <RequestDetailPanel
                data={data}
                requestID={loading || error ? "" : selectedRequestID}
                detail={loading || error || detail?.log.request_id !== selectedRequestID ? null : detail}
                loading={detailLoading}
                error={detailError}
              />
            </div>
          </div>
        </DataSection>
      ) : (
        <DataSection title="后台操作审计">
          <SimpleTable
            columns={["时间", "操作人", "动作", "对象", "对象 ID", "状态", "来源 IP"]}
            paginationKey="admin-audit-events"
            rows={data.auditEvents.map((event) => [
              formatTime(event.created_at),
              event.actor_name || event.actor_user_id || "-",
              actionLabel(event.action),
              resourceTypeLabel(event.resource_type),
              event.resource_id || "-",
              <StatusPill key={event.id} status={event.status === "success" ? "ok" : "error"} label={enumValueLabel(event.status)} />,
              event.ip || "-",
            ])}
          />
        </DataSection>
      )}
    </div>
  );
}

export function RequestDetailPanel({
  data,
  requestID,
  detail,
  loading,
  error,
}: {
  data: AppData;
  requestID: string;
  detail: RequestDetail | null;
  loading: boolean;
  error: string;
}) {
  const [copied, setCopied] = useState(false);

  if (!requestID) {
    return (
      <div className="request-detail-panel">
        <div className="compact-empty">{tx("暂无大模型请求记录")}</div>
      </div>
    );
  }

  if (loading && !detail) {
    return (
      <div className="request-detail-panel">
        <div className="compact-empty">{tx("正在加载请求详情...")}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="request-detail-panel">
        <div className="status-line error">{error}</div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="request-detail-panel">
        <div className="compact-empty">{tx("请选择一条请求")}</div>
      </div>
    );
  }

  const { log } = detail;
  const usageTotals = detail.usage.reduce(
    (sum, item) => ({
      input_tokens: sum.input_tokens + (item.input_tokens || 0),
      cached_input_tokens: sum.cached_input_tokens + (item.cached_input_tokens || 0),
      output_tokens: sum.output_tokens + (item.output_tokens || 0),
      total_tokens: sum.total_tokens + (item.total_tokens || 0),
      estimated_cost_usd: sum.estimated_cost_usd + (item.estimated_cost_usd || 0),
    }),
    { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0, estimated_cost_usd: 0 },
  );
  const isError = log.status_code >= 400;

  async function copyRequestID() {
    await navigator.clipboard?.writeText(log.request_id).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className="request-detail-panel">
      <div className="request-detail-head">
        <div>
          <span>{tx("请求详情")}</span>
          <strong>{log.model || "-"}</strong>
        </div>
        <StatusPill status={isError ? "error" : "ok"} label={String(log.status_code || "-")} />
      </div>

      <div className="request-id-line">
        <code>{log.request_id}</code>
        <button type="button" className="request-copy-button" onClick={() => void copyRequestID()} title={tx("复制请求 ID")}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>

      <div className="request-detail-grid">
        <DetailField label="时间" value={formatTime(log.created_at)} />
        <DetailField label="延迟" value={`${log.latency_ms || 0}ms`} />
        <DetailField label="项目" value={projectName(data, log.project_id)} />
        <DetailField label="API Key" value={apiKeyAuditLabel(data, log.api_key_id)} />
        <DetailField label="最终 Provider" value={providerAuditLabel(data, log)} />
        <DetailField label="Provider 资源" value={providerResourceAuditLabel(data, log.provider_resource_id)} />
        <DetailField label="上游模型" value={log.provider_model || "-"} />
        <DetailField label="客户端 IP" value={log.client_ip || "-"} />
      </div>

      {log.error_code ? (
        <div className="request-error-box">
          <strong>{log.error_code}</strong>
        </div>
      ) : null}

      <RequestPayloadSection payload={detail.payload ?? null} />

      <div className="request-subsection">
        <div className="request-subsection-title">
          <span>{tx("Token 与成本")}</span>
          <strong>{detail.usage.length ? countWithUnit(detail.usage.length, "条记录", "record", "件の記録") : tx("暂无记录")}</strong>
        </div>
        <div className="request-usage-strip">
          <UsageStat label="输入" value={compactNumber(usageTotals.input_tokens)} />
          <UsageStat label="缓存读" value={compactNumber(usageTotals.cached_input_tokens)} />
          <UsageStat label="输出" value={compactNumber(usageTotals.output_tokens)} />
          <UsageStat label="总量" value={compactNumber(usageTotals.total_tokens)} />
          <UsageStat label="估算成本" value={`$${formatMoney(usageTotals.estimated_cost_usd)}`} />
        </div>
      </div>

      <div className="request-subsection">
        <div className="request-subsection-title">
          <span>{tx("路由尝试")}</span>
          <strong>{routeAttemptCountText(detail.attempts.length)}</strong>
        </div>
        {detail.attempts.length === 0 ? (
          <div className="compact-empty">{tx("没有记录到路由尝试")}</div>
        ) : (
          <div className="attempt-timeline">
            {detail.attempts.map((attempt) => (
              <div className="attempt-row" key={attempt.id || `${attempt.request_id}-${attempt.attempt_index}`}>
                <div className={`attempt-marker ${attempt.status_code >= 400 ? "error" : "ok"}`}>
                  {attempt.attempt_index}
                </div>
                <div className="attempt-content">
                  <div className="attempt-head">
                    <strong>{providerAttemptLabel(data, attempt)}</strong>
                    <StatusPill
                      status={attempt.status_code >= 400 ? "error" : "ok"}
                      label={String(attempt.status_code || "-")}
                    />
                  </div>
                  <div className="attempt-meta">
                    <span>{tx("上游模型")} {attempt.provider_model || "-"}</span>
                    <span>{tx("资源")} {providerResourceAuditLabel(data, attempt.provider_resource_id)}</span>
                    <span>{tx("路由")} {attempt.route_id || "-"}</span>
                  </div>
                  {attempt.error_code || attempt.error_message ? (
                    <p className="attempt-error">
                      {[attempt.error_code, attempt.error_message].filter(Boolean).join(" · ")}
                    </p>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="request-client-agent">
        <span>User-Agent</span>
        <code>{log.user_agent || "-"}</code>
      </div>
    </div>
  );
}

export function DetailField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="detail-field">
      <span>{tx(label)}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function UsageStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="usage-stat">
      <span>{tx(label)}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function RequestPayloadSection({ payload }: { payload: RequestPayloadLog | null }) {
  return (
    <div className="request-subsection">
      <div className="request-subsection-title">
        <span>{tx("请求与响应")}</span>
        <strong>{payload ? tx("已记录快照") : tx("未记录")}</strong>
      </div>
      {!payload ? (
        <div className="compact-empty">{tx("这条历史记录没有保存 request / response 快照")}</div>
      ) : (
        <div className="payload-grid">
          <PayloadBlock
            title="Request"
            body={payload.request_body || tx("未记录请求内容")}
            truncated={payload.request_truncated}
          />
          <PayloadBlock
            title="Response"
            body={payload.response_body || tx("未记录响应内容")}
            truncated={payload.response_truncated}
          />
        </div>
      )}
    </div>
  );
}

export function PayloadBlock({ title, body, truncated }: { title: string; body: string; truncated: boolean }) {
  return (
    <div className="payload-block">
      <div className="payload-block-head">
        <span>{title}</span>
        {truncated ? <strong>{tx("已截断")}</strong> : null}
      </div>
      <pre>
        <code>{body}</code>
      </pre>
    </div>
  );
}

export function RequestMetric({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ size?: number }>;
}) {
  return (
    <article className="metric compact-metric">
      <div className="metric-label">
        <Icon size={17} />
        {tx(label)}
      </div>
      <div className="metric-value">{value}</div>
    </article>
  );
}
