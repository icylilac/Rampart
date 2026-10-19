import { Icon } from "./Icon";

/** Heights (percent) of the stepped bars: a ramp rising to the verified delivery. */
const STEPS = [4, 10, 18, 28, 40, 54, 70, 86, 100];
const TOP = STEPS.length - 1;

/** The hero's stepped ramp in brand teal, with the "verified" chip over the top step. */
export function RampVisual() {
  return (
    <div className="ramp" aria-hidden>
      <div className="ramp-bars">
        {STEPS.map((h, i) => (
          <div key={i} className="ramp-bar" style={{ height: `${h}%`, animationDelay: `${i * 60}ms` }}>
            {i === TOP && (
              <div className="ramp-chip">
                <Icon name="check" />
                <span>Verified on Stellar</span>
              </div>
            )}
          </div>
        ))}
      </div>
      <svg className="ramp-slope" viewBox="0 0 100 100" preserveAspectRatio="none">
        <polygon points="0,100 100,100 100,52" />
      </svg>
    </div>
  );
}
