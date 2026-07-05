"use client";

import type {
  ContractorOnboardingField,
  ContractorOnboardingPayload,
} from "../../lib/assistantSurface";

const LABELS: Record<ContractorOnboardingField, string> = {
  business_name: "Business name",
  trade: "Trade",
  service_area: "Service area",
  phone_or_email: "Phone or email",
  licensed: "Licensed?",
  same_day: "Same-day jobs?",
  locally_owned: "Locally owned?",
};

function boolText(value: boolean | undefined): string {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return "Not answered";
}

function missingLabel(field: ContractorOnboardingField): string {
  return LABELS[field] ?? field;
}

export function ContractorOnboardingPanel({
  payload,
}: {
  payload: ContractorOnboardingPayload;
}) {
  const d = payload.draft;
  const serviceArea =
    [d.city, d.state].filter(Boolean).join(", ") ||
    (d.lat != null && d.lng != null
      ? `${d.lat.toFixed(3)}, ${d.lng.toFixed(3)}`
      : "Not answered");
  const contact = [d.phone, d.email].filter(Boolean).join(" · ") || "Not answered";

  return (
    <div className="space-y-4 text-sm">
      <div className="rounded-xl border border-[#e0aa62]/30 bg-[#3a2108]/30 p-4">
        <p className="brand-grad-text text-xs uppercase tracking-[0.16em]">
          {payload.status === "saved" ? "Profile saved" : "Contractor sign-up"}
        </p>
        <h3 className="mt-2 text-lg font-semibold text-[#ffe9c2]">
          {d.business_name || "New contractor profile"}
        </h3>
        <p className="mt-1 text-xs text-[#f3d9b0]/80">
          6 is collecting this by voice. Nothing goes live until the save step
          succeeds.
        </p>
      </div>

      <dl className="space-y-2">
        <Field label="Trade" value={d.categories?.join(", ") || "Not answered"} />
        <Field label="Service area" value={serviceArea} />
        <Field label="Contact" value={contact} />
        <Field label="Licensed" value={boolText(d.licensed_flag)} />
        <Field label="Same-day jobs" value={boolText(d.same_day_flag)} />
        <Field label="Locally owned" value={boolText(d.locally_owned)} />
      </dl>

      {payload.missing_fields.length > 0 ? (
        <div className="rounded-xl border border-[#e0aa62]/20 bg-[#241406]/60 p-3">
          <p className="text-xs uppercase tracking-[0.14em] text-[#e0aa62]">
            Still needed
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {payload.missing_fields.map((field) => (
              <span
                key={field}
                className="rounded-full border border-[#e0aa62]/30 px-2 py-1 text-xs text-[#ffe9c2]"
              >
                {missingLabel(field)}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <p className="rounded-xl border border-[#d7a05a]/40 bg-[#d7a05a]/10 p-3 text-[#ffe9c2]">
          Ready to save when the contractor confirms.
        </p>
      )}

      {payload.confirmation && (
        <p className="rounded-xl border border-[#d7a05a]/40 bg-[#d7a05a]/10 p-3 text-[#ffe9c2]">
          {payload.confirmation}
        </p>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[#e0aa62]/15 bg-[#241406]/40 p-3">
      <dt className="text-[11px] uppercase tracking-[0.14em] text-[#e0aa62]">
        {label}
      </dt>
      <dd className="mt-1 text-[#ffe9c2]">{value}</dd>
    </div>
  );
}
