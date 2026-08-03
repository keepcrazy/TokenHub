package server

import (
	"testing"
	"time"
)

func TestNewWithConfigSetsProviderRequestTimeoutToTenMinutes(t *testing.T) {
	app := NewWithConfig(NewMemoryStore(), Config{})

	adapter, ok := app.adapters[ProviderOpenAICompatible].(OpenAICompatibleAdapter)
	if !ok {
		t.Fatalf("expected OpenAI-compatible adapter, got %T", app.adapters[ProviderOpenAICompatible])
	}
	if adapter.Client == nil {
		t.Fatal("expected OpenAI-compatible adapter HTTP client")
	}
	if adapter.Client.Timeout != 10*time.Minute {
		t.Fatalf("expected provider request timeout 10m, got %s", adapter.Client.Timeout)
	}
}
