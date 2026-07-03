-- M4.2 — Crew & laborer marketplace.
--
-- Vision ¶24: "can find them new laborers and subcontractors when they
-- need help."
--
-- Two tables:
--   * crew_requests           — the request a hiring contractor made
--   * crew_request_responses  — one row per invited helper contractor
--                                (accepted / declined / no-response)
--
-- Flow:
--   1. Silver+ contractor posts a request via the dashboard "Find help"
--      form (or, in a follow-up, the `find_helper` voice intent).
--   2. Backend reuses M2.1 search in same-day mode, picks top-N
--      candidates (excluding the requester), inserts one row per
--      candidate into crew_request_responses (status='invited').
--   3. Each invited helper gets a contractor-to-contractor email via
--      the M1.7 fabric (template crew.invitation.v1).
--   4. Helper hits accept/decline in their dashboard incoming panel;
--      route patches the response row.
--   5. First accept flips the request row to status='filled'; the
--      requester's dashboard tile updates on next refresh.
--
-- Tier gate: silver+ (crew_marketplace) — enforced in the create route,
-- not the schema.
--
-- RLS: requester reads/writes their own crew_requests; each invited
-- helper reads their own response rows. Service role bypasses.

CREATE TABLE IF NOT EXISTS public.crew_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_contractor_id uuid NOT NULL REFERENCES public.contractors(id) ON DELETE CASCADE,
  requester_user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Category slug the requester needs — usually mirrors the trade
  -- they can't cover for this job (a plumber asking for a tile-setter
  -- posts category='flooring' or 'handyman' etc.).
  category              text NOT NULL,
  needed_at             timestamptz NOT NULL,
  radius_km             int  NOT NULL DEFAULT 40 CHECK (radius_km BETWEEN 1 AND 200),
  scope                 text NOT NULL DEFAULT '',
  -- Optional appointment this request is filling for — future join
  -- so 6 can automatically credit the helper on the job log.
  appointment_id        uuid REFERENCES public.appointments(id) ON DELETE SET NULL,
  status                text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'filled', 'expired', 'cancelled')),
  filled_by_contractor_id uuid REFERENCES public.contractors(id) ON DELETE SET NULL,
  filled_at             timestamptz,
  context               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crew_requests_requester
  ON public.crew_requests (requester_contractor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crew_requests_open
  ON public.crew_requests (status, needed_at)
  WHERE status = 'open';

DROP TRIGGER IF EXISTS crew_requests_touch_updated_at ON public.crew_requests;
CREATE TRIGGER crew_requests_touch_updated_at
  BEFORE UPDATE ON public.crew_requests
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.crew_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "crew_requests: requester-read" ON public.crew_requests;
CREATE POLICY "crew_requests: requester-read"
  ON public.crew_requests
  FOR SELECT TO authenticated
  USING (requester_user_id = auth.uid());

CREATE TABLE IF NOT EXISTS public.crew_request_responses (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crew_request_id       uuid NOT NULL REFERENCES public.crew_requests(id) ON DELETE CASCADE,
  invitee_contractor_id uuid NOT NULL REFERENCES public.contractors(id) ON DELETE CASCADE,
  -- Snapshot the ranking score so we can rank late-arriving accepts.
  rank_score            double precision NOT NULL DEFAULT 0,
  distance_km           double precision,
  status                text NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited', 'accepted', 'declined', 'expired', 'no_response')),
  notification_row_id   uuid,
  responded_at          timestamptz,
  context               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (crew_request_id, invitee_contractor_id)
);

CREATE INDEX IF NOT EXISTS idx_crew_responses_invitee
  ON public.crew_request_responses (invitee_contractor_id, status);
CREATE INDEX IF NOT EXISTS idx_crew_responses_request
  ON public.crew_request_responses (crew_request_id, status);

DROP TRIGGER IF EXISTS crew_responses_touch_updated_at
  ON public.crew_request_responses;
CREATE TRIGGER crew_responses_touch_updated_at
  BEFORE UPDATE ON public.crew_request_responses
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.crew_request_responses ENABLE ROW LEVEL SECURITY;

-- Invitee sees their own invitations.
DROP POLICY IF EXISTS "crew_responses: invitee-read"
  ON public.crew_request_responses;
CREATE POLICY "crew_responses: invitee-read"
  ON public.crew_request_responses
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.contractors c
      WHERE c.id = crew_request_responses.invitee_contractor_id
        AND c.claimed_by_user_id = auth.uid()
    )
  );

-- Requester sees responses on their own request.
DROP POLICY IF EXISTS "crew_responses: requester-read"
  ON public.crew_request_responses;
CREATE POLICY "crew_responses: requester-read"
  ON public.crew_request_responses
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.crew_requests r
      WHERE r.id = crew_request_responses.crew_request_id
        AND r.requester_user_id = auth.uid()
    )
  );
