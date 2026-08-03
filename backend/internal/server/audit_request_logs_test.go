package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"testing"
	"time"
)

type auditRequestLogsResponse struct {
	Data       []RequestLog `json:"data"`
	Pagination struct {
		Page       int   `json:"page"`
		PageSize   int   `json:"page_size"`
		Total      int64 `json:"total"`
		TotalPages int   `json:"total_pages"`
	} `json:"pagination"`
	Summary struct {
		All              int64   `json:"all"`
		OK               int64   `json:"ok"`
		Error            int64   `json:"error"`
		AverageLatencyMS float64 `json:"average_latency_ms"`
	} `json:"summary"`
}

func TestAdminRequestLogsDefaultPageIsBoundedAndStablyOrdered(t *testing.T) {
	store := NewMemoryStore()
	now := time.Date(2026, time.August, 3, 12, 0, 0, 0, time.UTC)
	for i := 1; i <= 100; i++ {
		createAuditRequestLog(t, store, RequestLog{
			ID:         fmt.Sprintf("log-page-%03d", i),
			RequestID:  fmt.Sprintf("req-page-%03d", i),
			StatusCode: http.StatusOK,
			LatencyMS:  int64(i),
			CreatedAt:  now.Add(-time.Duration(i) * time.Minute),
		})
	}
	createAuditRequestLog(t, store, RequestLog{ID: "log-tie-a", RequestID: "req-tie-a", StatusCode: http.StatusOK, LatencyMS: 101, CreatedAt: now})
	createAuditRequestLog(t, store, RequestLog{ID: "log-tie-b", RequestID: "req-tie-b", StatusCode: http.StatusOK, LatencyMS: 102, CreatedAt: now})

	app := New(store).Handler()
	first := decodeAuditRequestLogs(t, doJSON(t, app, http.MethodGet, "/api/admin/audit/requests", nil, ""))
	if got, want := len(first.Data), 100; got != want {
		t.Fatalf("default data count = %d, want %d", got, want)
	}
	if first.Pagination.Page != 1 || first.Pagination.PageSize != 100 || first.Pagination.Total != 102 || first.Pagination.TotalPages != 2 {
		t.Fatalf("default pagination = %#v, want page=1 page_size=100 total=102 total_pages=2", first.Pagination)
	}
	if first.Data[0].RequestID != "req-tie-b" || first.Data[1].RequestID != "req-tie-a" {
		t.Fatalf("same-timestamp ordering = %q, %q; want req-tie-b, req-tie-a", first.Data[0].RequestID, first.Data[1].RequestID)
	}

	second := decodeAuditRequestLogs(t, doJSON(t, app, http.MethodGet, "/api/admin/audit/requests?page=2", nil, ""))
	if got, want := len(second.Data), 2; got != want {
		t.Fatalf("page 2 data count = %d, want %d", got, want)
	}
	if second.Data[0].RequestID != "req-page-099" || second.Data[1].RequestID != "req-page-100" {
		t.Fatalf("page 2 ordering = %q, %q; want req-page-099, req-page-100", second.Data[0].RequestID, second.Data[1].RequestID)
	}
}

func TestAdminRequestLogsFiltersAndRejectsInvalidParameters(t *testing.T) {
	store := NewMemoryStore()
	project := store.CreateProject(Project{ID: "prj-search", Name: "Searchable Project", Status: StatusActive})
	provider := store.AddProvider(Provider{ID: "prv-search", Name: "Fallback Provider", Type: ProviderOpenAI, Status: StatusActive})
	resource, err := store.AddProviderResource(ProviderResource{ID: "rsrc-search", ProviderID: provider.ID, Name: "search account", ResourceType: "api_key", Status: StatusActive})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, time.August, 3, 12, 0, 0, 0, time.UTC)
	createAuditRequestLog(t, store, RequestLog{ID: "log-ok-search", RequestID: "req-needle%_\\\\", ProjectID: project.ID, ModelName: "gpt-search", StatusCode: http.StatusOK, LatencyMS: 20, CreatedAt: now})
	createAuditRequestLog(t, store, RequestLog{ID: "log-error-search", RequestID: "req-error-search", ProjectID: project.ID, ProviderResourceID: resource.ID, ProviderModel: "upstream-search", StatusCode: http.StatusTooManyRequests, ErrorCode: "rate_limited", LatencyMS: 80, CreatedAt: now.Add(-time.Minute)})
	createAuditRequestLog(t, store, RequestLog{ID: "log-other-search", RequestID: "req-other-search", ModelName: "other", StatusCode: http.StatusCreated, LatencyMS: 40, CreatedAt: now.Add(-2 * time.Minute)})

	app := New(store).Handler()
	query := url.QueryEscape("fallback provider")
	matched := decodeAuditRequestLogs(t, doJSON(t, app, http.MethodGet, "/api/admin/audit/requests?q="+query, nil, ""))
	if got, want := len(matched.Data), 1; got != want || matched.Data[0].RequestID != "req-error-search" {
		t.Fatalf("provider fallback search = %#v, want only req-error-search", matched.Data)
	}
	if matched.Pagination.Total != 1 || matched.Summary.All != 3 || matched.Summary.OK != 2 || matched.Summary.Error != 1 || matched.Summary.AverageLatencyMS != 140.0/3.0 {
		t.Fatalf("search totals = pagination %#v summary %#v", matched.Pagination, matched.Summary)
	}

	errors := decodeAuditRequestLogs(t, doJSON(t, app, http.MethodGet, "/api/admin/audit/requests?status=error", nil, ""))
	if got, want := len(errors.Data), 1; got != want || errors.Data[0].RequestID != "req-error-search" {
		t.Fatalf("error status data = %#v, want only req-error-search", errors.Data)
	}
	combined := decodeAuditRequestLogs(t, doJSON(t, app, http.MethodGet, "/api/admin/audit/requests?status=error&q="+query, nil, ""))
	if combined.Pagination.Total != 1 || len(combined.Data) != 1 || combined.Data[0].RequestID != "req-error-search" || combined.Summary.All != 3 {
		t.Fatalf("combined search and status = pagination %#v summary %#v data %#v", combined.Pagination, combined.Summary, combined.Data)
	}
	escaped := decodeAuditRequestLogs(t, doJSON(t, app, http.MethodGet, "/api/admin/audit/requests?q="+url.QueryEscape("needle%_\\\\"), nil, ""))
	if got, want := len(escaped.Data), 1; got != want || escaped.Data[0].RequestID != "req-needle%_\\\\" {
		t.Fatalf("escaped search data = %#v, want only literal special-character request", escaped.Data)
	}

	for _, rawQuery := range []string{"page=0", "page=-1", "page=invalid", "page=9223372036854775807", "page_size=0", "page_size=-1", "page_size=101", "page_size=invalid", "status=unknown"} {
		response := doJSON(t, app, http.MethodGet, "/api/admin/audit/requests?"+rawQuery, nil, "")
		if response.Code != http.StatusBadRequest {
			t.Fatalf("query %q status = %d, want 400: %s", rawQuery, response.Code, response.Body)
		}
	}
}

func TestAdminRequestLogsEmptyScopeReturnsNoDataOrSummary(t *testing.T) {
	store := NewMemoryStore()
	user, err := store.CreateAdminUser(AdminUser{Username: "audit-empty", Email: "audit-empty@tokenhub.local", Role: "user", Status: StatusActive}, "empty-password")
	if err != nil {
		t.Fatal(err)
	}
	createAuditRequestLog(t, store, RequestLog{ID: "log-empty-hidden", RequestID: "req-empty-hidden", StatusCode: http.StatusInternalServerError, LatencyMS: 99, CreatedAt: time.Date(2026, time.August, 3, 12, 0, 0, 0, time.UTC)})

	app := New(store).Handler()
	token := loginAuditUser(t, app, user.Email, "empty-password")
	response := decodeAuditRequestLogs(t, doJSON(t, app, http.MethodGet, "/api/admin/audit/requests", nil, token))
	if len(response.Data) != 0 || response.Pagination.Total != 0 || response.Pagination.TotalPages != 0 || response.Summary.All != 0 || response.Summary.OK != 0 || response.Summary.Error != 0 || response.Summary.AverageLatencyMS != 0 {
		t.Fatalf("empty-scope response = pagination %#v summary %#v data %#v", response.Pagination, response.Summary, response.Data)
	}
}

func TestAdminRequestLogsApplyPermissionBeforeTotalsAndSummary(t *testing.T) {
	store := NewMemoryStore()
	leader, err := store.CreateAdminUser(AdminUser{Username: "audit-leader", Email: "audit-leader@tokenhub.local", Role: "team_leader", TeamID: "team-audit", Status: StatusActive}, "leader-password")
	if err != nil {
		t.Fatal(err)
	}
	normal, err := store.CreateAdminUser(AdminUser{Username: "audit-user", Email: "audit-user@tokenhub.local", Role: "user", Status: StatusActive}, "user-password")
	if err != nil {
		t.Fatal(err)
	}
	teamProject := store.CreateProject(Project{ID: "prj-team-audit", Name: "Team Audit", TeamID: leader.TeamID, Status: StatusActive})
	otherProject := store.CreateProject(Project{ID: "prj-other-audit", Name: "Other Audit", Status: StatusActive})
	teamKey, _, err := store.CreateAPIKey(teamProject.ID, APIKey{ID: "key-team-audit", Name: "team key", Status: StatusActive}, "thk_team_audit")
	if err != nil {
		t.Fatal(err)
	}
	leaderKey, _, err := store.CreateAPIKey(otherProject.ID, APIKey{ID: "key-leader-audit", Name: "leader key", OwnerUserID: leader.ID, Status: StatusActive}, "thk_leader_audit")
	if err != nil {
		t.Fatal(err)
	}
	userKey, _, err := store.CreateAPIKey(otherProject.ID, APIKey{ID: "key-user-audit", Name: "user key", OwnerUserID: normal.ID, Status: StatusActive}, "thk_user_audit")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, time.August, 3, 12, 0, 0, 0, time.UTC)
	createAuditRequestLog(t, store, RequestLog{ID: "log-team-project", RequestID: "req-team-project", ProjectID: teamProject.ID, StatusCode: http.StatusOK, LatencyMS: 10, CreatedAt: now})
	createAuditRequestLog(t, store, RequestLog{ID: "log-leader-key", RequestID: "req-leader-key", ProjectID: otherProject.ID, APIKeyID: leaderKey.ID, StatusCode: http.StatusInternalServerError, LatencyMS: 30, CreatedAt: now.Add(-time.Minute)})
	createAuditRequestLog(t, store, RequestLog{ID: "log-team-key", RequestID: "req-team-key", ProjectID: otherProject.ID, APIKeyID: teamKey.ID, StatusCode: http.StatusOK, LatencyMS: 50, CreatedAt: now.Add(-2 * time.Minute)})
	createAuditRequestLog(t, store, RequestLog{ID: "log-user-key", RequestID: "req-user-key", ProjectID: otherProject.ID, APIKeyID: userKey.ID, StatusCode: http.StatusBadRequest, LatencyMS: 70, CreatedAt: now.Add(-3 * time.Minute)})
	createAuditRequestLog(t, store, RequestLog{ID: "log-hidden", RequestID: "req-hidden", ProjectID: otherProject.ID, StatusCode: http.StatusOK, LatencyMS: 90, CreatedAt: now.Add(-4 * time.Minute)})

	app := New(store).Handler()
	leaderToken := loginAuditUser(t, app, "audit-leader@tokenhub.local", "leader-password")
	leaderResponse := decodeAuditRequestLogs(t, doJSON(t, app, http.MethodGet, "/api/admin/audit/requests?status=error", nil, leaderToken))
	if leaderResponse.Pagination.Total != 1 || leaderResponse.Summary.All != 3 || leaderResponse.Summary.OK != 2 || leaderResponse.Summary.Error != 1 || leaderResponse.Summary.AverageLatencyMS != 30 {
		t.Fatalf("leader totals = pagination %#v summary %#v", leaderResponse.Pagination, leaderResponse.Summary)
	}
	if got, want := leaderResponse.Data[0].RequestID, "req-leader-key"; got != want {
		t.Fatalf("leader error data = %q, want %q", got, want)
	}

	userToken := loginAuditUser(t, app, "audit-user@tokenhub.local", "user-password")
	userResponse := decodeAuditRequestLogs(t, doJSON(t, app, http.MethodGet, "/api/admin/audit/requests", nil, userToken))
	if userResponse.Pagination.Total != 1 || userResponse.Summary.All != 1 || userResponse.Summary.OK != 0 || userResponse.Summary.Error != 1 || userResponse.Data[0].RequestID != "req-user-key" {
		t.Fatalf("normal user response = pagination %#v summary %#v data %#v", userResponse.Pagination, userResponse.Summary, userResponse.Data)
	}
}

func TestAdminRequestLogsSearchOnlyUsesVisibleEntityNames(t *testing.T) {
	store := NewMemoryStore()
	admin, err := store.CreateAdminUser(AdminUser{Username: "audit-search-admin", Email: "audit-search-admin@tokenhub.local", Role: "admin", Status: StatusActive}, "admin-password")
	if err != nil {
		t.Fatal(err)
	}
	user, err := store.CreateAdminUser(AdminUser{Username: "audit-search-user", Email: "audit-search-user@tokenhub.local", Role: "user", Status: StatusActive}, "search-password")
	if err != nil {
		t.Fatal(err)
	}
	visibleProject := store.CreateProject(Project{ID: "prj-visible-search", Name: "Visible Project Needle", OwnerUserID: user.ID, Status: StatusActive})
	hiddenProject := store.CreateProject(Project{ID: "prj-hidden-search", Name: "Hidden Project Needle", Status: StatusActive})
	visibleKey, _, err := store.CreateAPIKey(visibleProject.ID, APIKey{ID: "key-visible-search", Name: "visible key", OwnerUserID: user.ID, Status: StatusActive}, "thk_visible_search")
	if err != nil {
		t.Fatal(err)
	}
	hiddenKey, _, err := store.CreateAPIKey(hiddenProject.ID, APIKey{ID: "key-hidden-search", Name: "hidden key", OwnerUserID: user.ID, Status: StatusActive}, "thk_hidden_search")
	if err != nil {
		t.Fatal(err)
	}
	provider := store.AddProvider(Provider{ID: "prv-hidden-search", Name: "Hidden Provider Needle", Type: ProviderOpenAI, Status: StatusActive})
	now := time.Date(2026, time.August, 3, 12, 0, 0, 0, time.UTC)
	createAuditRequestLog(t, store, RequestLog{ID: "log-visible-name", RequestID: "req-visible-name", ProjectID: visibleProject.ID, APIKeyID: visibleKey.ID, StatusCode: http.StatusOK, CreatedAt: now})
	createAuditRequestLog(t, store, RequestLog{ID: "log-hidden-name", RequestID: "req-hidden-name", ProjectID: hiddenProject.ID, APIKeyID: hiddenKey.ID, ProviderID: provider.ID, StatusCode: http.StatusOK, CreatedAt: now.Add(-time.Minute)})

	app := New(store).Handler()
	token := loginAuditUser(t, app, user.Email, "search-password")
	visibleMatch := decodeAuditRequestLogs(t, doJSON(t, app, http.MethodGet, "/api/admin/audit/requests?q="+url.QueryEscape(visibleProject.Name), nil, token))
	if visibleMatch.Pagination.Total != 1 || len(visibleMatch.Data) != 1 || visibleMatch.Data[0].RequestID != "req-visible-name" {
		t.Fatalf("visible project-name search = pagination %#v data %#v", visibleMatch.Pagination, visibleMatch.Data)
	}
	for _, hiddenName := range []string{hiddenProject.Name, provider.Name} {
		response := decodeAuditRequestLogs(t, doJSON(t, app, http.MethodGet, "/api/admin/audit/requests?q="+url.QueryEscape(hiddenName), nil, token))
		if response.Pagination.Total != 0 || len(response.Data) != 0 {
			t.Fatalf("hidden entity-name search %q exposed pagination %#v data %#v", hiddenName, response.Pagination, response.Data)
		}
	}

	adminToken := loginAuditUser(t, app, admin.Email, "admin-password")
	adminMatch := decodeAuditRequestLogs(t, doJSON(t, app, http.MethodGet, "/api/admin/audit/requests?q="+url.QueryEscape(provider.Name), nil, adminToken))
	if adminMatch.Pagination.Total != 1 || len(adminMatch.Data) != 1 || adminMatch.Data[0].RequestID != "req-hidden-name" {
		t.Fatalf("global provider-name search = pagination %#v data %#v", adminMatch.Pagination, adminMatch.Data)
	}
}

func createAuditRequestLog(t *testing.T, store *GormStore, log RequestLog) {
	t.Helper()
	if err := store.db.Create(&log).Error; err != nil {
		t.Fatal(err)
	}
}

func decodeAuditRequestLogs(t *testing.T, response responseBody) auditRequestLogsResponse {
	t.Helper()
	if response.Code != http.StatusOK {
		t.Fatalf("request logs status = %d, want 200: %s", response.Code, response.Body)
	}
	var payload auditRequestLogsResponse
	if err := json.Unmarshal([]byte(response.Body), &payload); err != nil {
		t.Fatal(err)
	}
	return payload
}

func loginAuditUser(t *testing.T, app http.Handler, identity, password string) string {
	t.Helper()
	response := doJSON(t, app, http.MethodPost, "/api/admin/auth/login", map[string]any{"identity": identity, "password": password}, "")
	if response.Code != http.StatusOK {
		t.Fatalf("login status = %d, want 200: %s", response.Code, response.Body)
	}
	var payload struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal([]byte(response.Body), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Token == "" {
		t.Fatalf("login returned empty token: %s", response.Body)
	}
	return payload.Token
}
