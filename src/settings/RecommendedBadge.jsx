import { Badge as LwBadge } from "../components/lightswind/badge";

export const RECOMMENDATION_HINT = "Suggested option. VupsRouter supports many other providers too; setup requirements differ.";

export function RecommendedBadge({ show = false }) {
  if (!show) return null;
  return (
    <LwBadge
      variant="unstyled"
      size="unstyled"
      shape="unstyled"
      className="settings-badge settings-badge--recommended"
      title={RECOMMENDATION_HINT}
      aria-label={RECOMMENDATION_HINT}
    >
      Recommended
    </LwBadge>
  );
}
