"use client";

import { create } from "zustand";
import type {
  AppointmentSurfacePayload,
  CallPayload,
  ComparePayload,
  ContractPayload,
  ContractorCard,
  ContractorOnboardingPayload,
  DisputePayload,
  EstimatePayload,
  PickResultPayload,
  RecommendationCard,
  RecurringJobPayload,
  SummaryPayload,
  SurfaceVariant,
  TodoPayload,
} from "./types";

/**
 * Assistant Surface store (M3.0b).
 *
 * Holds the currently-active surface variant and open/closed state.
 * Mutated by:
 *   - M3.0e intent classifier (after the M3.0d test drive ships)
 *   - any dev-mode test surface trigger
 *   - the existing /contractors page when the user explicitly opens
 *     a surface from the form-driven debug flow
 *
 * Replace-not-stack semantics: 6 is talking about one thing at a time.
 * Opening a new variant supersedes the previous one. Animation can
 * cross-fade if desired in a later polish pass; v1 is a hard swap.
 */

type AssistantSurfaceState = {
  variant: SurfaceVariant | null;
  isOpen: boolean;

  // Mutators
  showContractors: (
    hits: ContractorCard[],
    total_considered?: number,
  ) => void;
  showSummary: (payload: SummaryPayload, cached: boolean) => void;
  showRecommendations: (
    picks: RecommendationCard[],
    preference_facts?: string[],
  ) => void;
  showPickResult: (payload: PickResultPayload) => void;
  showCompare: (payload: ComparePayload) => void;
  showAppointment: (payload: AppointmentSurfacePayload) => void;
  showContract: (payload: ContractPayload) => void;
  showDispute: (payload: DisputePayload) => void;
  showCall: (payload: CallPayload) => void;
  showEstimate: (payload: EstimatePayload) => void;
  showRecurring: (payload: RecurringJobPayload) => void;
  showTodo: (payload: TodoPayload) => void;
  showContractorOnboarding: (payload: ContractorOnboardingPayload) => void;
  dismiss: () => void;
  /** Hard reset — clears the variant entirely (vs just hiding it). */
  reset: () => void;
};

export const useAssistantSurface = create<AssistantSurfaceState>((set) => ({
  variant: null,
  isOpen: false,

  showContractors: (hits, total_considered = hits.length) =>
    set({
      variant: { kind: "contractors", hits, total_considered },
      isOpen: true,
    }),

  showSummary: (payload, cached) =>
    set({
      variant: { kind: "summary", payload, cached },
      isOpen: true,
    }),

  showRecommendations: (picks, preference_facts = []) =>
    set({
      variant: { kind: "picks", picks, preference_facts },
      isOpen: true,
    }),

  showPickResult: (payload) =>
    set({
      variant: { kind: "pickResult", payload },
      isOpen: true,
    }),

  showCompare: (payload) =>
    set({
      variant: { kind: "compare", payload },
      isOpen: true,
    }),

  showAppointment: (payload) =>
    set({
      variant: { kind: "appointment", payload },
      isOpen: true,
    }),

  showContract: (payload) =>
    set({
      variant: { kind: "contract", payload },
      isOpen: true,
    }),

  showDispute: (payload) =>
    set({
      variant: { kind: "dispute", payload },
      isOpen: true,
    }),

  showCall: (payload) =>
    set({
      variant: { kind: "call", payload },
      isOpen: true,
    }),

  showEstimate: (payload) =>
    set({
      variant: { kind: "estimate", payload },
      isOpen: true,
    }),

  showRecurring: (payload) =>
    set({
      variant: { kind: "recurring", payload },
      isOpen: true,
    }),

  showTodo: (payload) =>
    set({
      variant: { kind: "todo", payload },
      isOpen: true,
    }),

  showContractorOnboarding: (payload) =>
    set({
      variant: { kind: "contractorOnboarding", payload },
      isOpen: true,
    }),

  dismiss: () => set({ isOpen: false }),

  reset: () => set({ variant: null, isOpen: false }),
}));

/**
 * Dev-only helper to drive the surface from the browser console:
 *   window.__assistantSurface.showContractors([...])
 * Useful before M3.0e ships. Tree-shaken in production.
 */
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  (window as unknown as Record<string, unknown>).__assistantSurface = {
    show: () => useAssistantSurface.getState(),
    showContractors: (hits: ContractorCard[]) =>
      useAssistantSurface.getState().showContractors(hits),
    showSummary: (payload: SummaryPayload, cached = false) =>
      useAssistantSurface.getState().showSummary(payload, cached),
    showRecommendations: (
      picks: RecommendationCard[],
      preference_facts: string[] = [],
    ) =>
      useAssistantSurface
        .getState()
        .showRecommendations(picks, preference_facts),
    showPickResult: (payload: PickResultPayload) =>
      useAssistantSurface.getState().showPickResult(payload),
    showCompare: (payload: ComparePayload) =>
      useAssistantSurface.getState().showCompare(payload),
    showAppointment: (payload: AppointmentSurfacePayload) =>
      useAssistantSurface.getState().showAppointment(payload),
    showContract: (payload: ContractPayload) =>
      useAssistantSurface.getState().showContract(payload),
    showDispute: (payload: DisputePayload) =>
      useAssistantSurface.getState().showDispute(payload),
    showCall: (payload: CallPayload) =>
      useAssistantSurface.getState().showCall(payload),
    showEstimate: (payload: EstimatePayload) =>
      useAssistantSurface.getState().showEstimate(payload),
    showRecurring: (payload: RecurringJobPayload) =>
      useAssistantSurface.getState().showRecurring(payload),
    showTodo: (payload: TodoPayload) =>
      useAssistantSurface.getState().showTodo(payload),
    showContractorOnboarding: (payload: ContractorOnboardingPayload) =>
      useAssistantSurface.getState().showContractorOnboarding(payload),
    dismiss: () => useAssistantSurface.getState().dismiss(),
    reset: () => useAssistantSurface.getState().reset(),
  };
}
