import type { NotificationTemplate } from "../types";
import welcomeTemplate from "./welcome";
import reportDeliveryTemplate from "./report-delivery";
import contractorWinTemplate from "./contractor-win";
import contractorLoseTemplate from "./contractor-lose";
import {
  appointmentReminder24hTemplate,
  appointmentReminder2hTemplate,
} from "./appointment-reminder";
import appointmentChecklistTemplate from "./appointment-checklist";
import coachingNudgeTemplate from "./coaching-nudge";
import crewInvitationTemplate from "./crew-invitation";
import crewFilledTemplate from "./crew-filled";
import contractorUrgentDispatchTemplate from "./contractor-urgent-dispatch";
import adminDisputeEscalationTemplate from "./admin-dispute-escalation";
import homeownerContractorIntroTemplate from "./homeowner-contractor-intro";

/**
 * Local-in-code template registry (Q1.7a).
 *
 * Each template owns its own renderEmail / renderSms / renderWhatsapp
 * variants for all supported locales. New templates land in this file
 * — e.g. report-delivery in M1.4, three-way-call-reminder in M3.4.
 *
 * WhatsApp template_name values MUST match a Meta-pre-approved Content
 * SID. While Meta BSP approval is pending, FEATURE_WHATSAPP=0 keeps
 * those code paths inert.
 */
const REGISTRY: Record<string, NotificationTemplate<never>> = {
  "welcome.v1": welcomeTemplate as NotificationTemplate<never>,
  "report.delivery.v1": reportDeliveryTemplate as NotificationTemplate<never>,
  "contractor.win.v1": contractorWinTemplate as NotificationTemplate<never>,
  "contractor.lose.v1": contractorLoseTemplate as NotificationTemplate<never>,
  "appointment.reminder.24h.v1":
    appointmentReminder24hTemplate as NotificationTemplate<never>,
  "appointment.reminder.2h.v1":
    appointmentReminder2hTemplate as NotificationTemplate<never>,
  "appointment.checklist.v1":
    appointmentChecklistTemplate as NotificationTemplate<never>,
  "coaching.nudge.v1":
    coachingNudgeTemplate as NotificationTemplate<never>,
  "crew.invitation.v1":
    crewInvitationTemplate as NotificationTemplate<never>,
  "crew.filled.v1":
    crewFilledTemplate as NotificationTemplate<never>,
  "contractor.urgent_dispatch.v1":
    contractorUrgentDispatchTemplate as NotificationTemplate<never>,
  "admin.dispute.escalation.v1":
    adminDisputeEscalationTemplate as NotificationTemplate<never>,
  "homeowner.contractor_intro.v1":
    homeownerContractorIntroTemplate as NotificationTemplate<never>,
};

export function getTemplate(id: string): NotificationTemplate<never> | null {
  return REGISTRY[id] ?? null;
}

export function listTemplateIds(): string[] {
  return Object.keys(REGISTRY);
}
