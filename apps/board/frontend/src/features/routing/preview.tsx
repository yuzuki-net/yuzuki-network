import { Banner as KumoBanner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../../assets/scripts/api";
import { Banner, Chip, SectionCard } from "../../components/console-ui";
import { english, useT } from "../../i18n";
import { actionLabels, routingUrl, type Policy, type Rule } from "./model";

type Decision = {
  action: Rule["action"];
  rule_index: number | null;
  group_id?: string | null;
  group_name?: string | null;
  skipped_dynamic_rules?: number[];
};

const SAMPLE_DESTINATIONS = ["chatgpt.com", "192.168.1.1", "8.8.8.8", "ads.doubleclick.net"];

export function RoutingPreview({
  published,
  draft,
  nativeChanged,
}: {
  published: Policy;
  draft?: Policy;
  nativeChanged: boolean;
}) {
  const t = useT("routing");
  const [source, setSource] = useState<"published" | "draft">(draft ? "draft" : "published");
  const [destination, setDestination] = useState("");
  const [port, setPort] = useState("");
  const policy = source === "draft" ? draft ?? published : published;
  const preview = useMutation({
    mutationFn: ({ target, portNum }: { target: string; portNum?: number }) =>
      api<Decision>(`${routingUrl}/preview`, "POST", {
        destination: target,
        ...(portNum ? { port: portNum } : {}),
        default_action: policy.default_action,
        default_group_id: policy.default_group_id ?? null,
        groups: policy.groups ?? [],
        rule_sets: policy.rule_sets ?? [],
        rules: policy.rules,
      }),
  });
  const result = preview.data;
  const rule = result?.rule_index !== null && result?.rule_index !== undefined ? policy.rules[result.rule_index] : undefined;
  const error =
    preview.error?.message === "Check the common routing rules."
      ? english("routing", "preview.ruleError", "Review the routing rules and policy groups before testing this draft.")
      : preview.error?.message === "Enter a domain or IP address."
        ? english("routing", "preview.inputError", "Enter a domain or IP address.")
        : preview.error?.message;

  function runTest(target: string) {
    const trimmed = target.trim();
    const parsedPort = port.trim() ? Number(port.trim()) : undefined;
    const validPort = parsedPort && Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : undefined;
    if (!preview.isPending && trimmed) preview.mutate({ target: trimmed, portNum: validPort });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    runTest(destination);
  }

  return (
    <SectionCard
      title={t("preview.title", "Check a destination")}
      description={t(
        "preview.help",
        "See the first matching rule or policy group for a domain, IP address, and optional port. Testing leaves the live policy untouched.",
      )}
    >
      <div className="flex flex-col gap-4">
        {draft && (
          <div className="max-w-xs">
            <Select
              label={t("preview.source", "Policy to test")}
              value={source}
              disabled={preview.isPending}
              items={{ published: t("tabs.live", "Published"), draft: t("tabs.draft", "Draft") }}
              onValueChange={(value: "published" | "draft" | null) => {
                if (value) {
                  setSource(value);
                  preview.reset();
                }
              }}
            />
          </div>
        )}

        <form className="grid items-start gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_auto]" onSubmit={submit}>
          <Input
            label={t("preview.destination", "Domain or IP address")}
            value={destination}
            dir="ltr"
            placeholder="chatgpt.com"
            maxLength={253}
            required
            disabled={preview.isPending}
            onChange={(event) => {
              setDestination(event.target.value);
              preview.reset();
            }}
          />
          <Input
            label={t("preview.port", "Port (optional)")}
            type="number"
            min={1}
            max={65535}
            value={port}
            dir="ltr"
            placeholder="443"
            disabled={preview.isPending}
            onChange={(event) => {
              setPort(event.target.value);
              preview.reset();
            }}
          />
          <div className="sm:mt-7">
            <Button variant="primary" type="submit" loading={preview.isPending} disabled={!destination.trim()} icon={MagnifyingGlass}>
              {t("preview.test", "Test destination")}
            </Button>
          </div>
        </form>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-kumo-subtle">{t("preview.samples", "Quick samples:")}</span>
          {SAMPLE_DESTINATIONS.map((sample) => (
            <Button
              key={sample}
              type="button"
              variant="secondary"
              size="xs"
              disabled={preview.isPending}
              onClick={() => {
                setDestination(sample);
                runTest(sample);
              }}
            >
              {sample}
            </Button>
          ))}
        </div>

        {(Object.keys(policy.native ?? {}).length > 0 || (source === "draft" && nativeChanged)) && (
          <KumoBanner
            size="sm"
            variant="secondary"
            description={t("preview.native", "This test evaluates the common rules. Native overrides can further adjust client behavior.")}
          />
        )}

        <Banner error={error} />

        {result && (
          <div className="flex flex-col gap-2 rounded-lg border border-kumo-line bg-kumo-recessed/40 p-3.5" role="status">
            <div className="routing-preview-result">
              <Chip
                tone={
                  result.action === "block"
                    ? "red"
                    : result.action === "direct"
                      ? "green"
                      : result.action === "group"
                        ? "amber"
                        : "blue"
                }
              >
                {result.action === "group" && result.group_name
                  ? t("action.groupTarget", "Group: {name}", { name: result.group_name })
                  : t("action." + result.action, actionLabels[result.action])}
              </Chip>
              {rule && result.rule_index !== null ? (
                <span className="text-sm text-kumo-default">
                  {t("preview.rule", "Matched rule #{index}", { index: result.rule_index + 1 })}{" "}
                  <code className="rounded bg-kumo-tint px-1.5 py-0.5 text-xs" dir="ltr">
                    {rule.kind}: {rule.value}
                  </code>
                </span>
              ) : (
                <span className="text-sm text-kumo-subtle">{t("preview.default", "Used the default action")}</span>
              )}
            </div>
            {result.skipped_dynamic_rules && result.skipped_dynamic_rules.length > 0 && (
              <p className="text-xs text-kumo-subtle">
                {t(
                  "preview.dynamicSkipped",
                  "Note: {count} GeoIP/GeoSite/Rule-Set/Process rule(s) precede this match and are evaluated dynamically on the client.",
                  { count: result.skipped_dynamic_rules.length },
                )}
              </p>
            )}
          </div>
        )}
      </div>
    </SectionCard>
  );
}
