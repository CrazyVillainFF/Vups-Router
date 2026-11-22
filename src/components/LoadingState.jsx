import "./LoadingState.css";

/* The supplied LoadingState pairs three things: a 3×3 pixel grid, a status
   label and an elapsed clock. Only the grid is ported here, because the chat's
   live row already owns the other two — ThoughtLine paints the real status text
   and runs the single 100ms tick that counts the turn, and a second timer in the
   same row would both duplicate that clock and re-type the label in a colour the
   product does not use. So this component moves, and says nothing. */

const CELL_DELAY_MS = 90;

/* Drive: the wave starts in the middle row and leaves the outer rows one step
   behind it, so the grid reads as an arrow pointing at the answer. */
const DRIVE_DURATION_MS = 650;

function driveDelays() {
  const delays = [];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      delays.push((column + Math.abs(row - 1)) * CELL_DELAY_MS);
    }
  }
  return delays;
}

const PATTERNS = {
  Drive: { duration: DRIVE_DURATION_MS, delays: driveDelays() }
};

export default function LoadingState({ variant = "Drive", className = "" }) {
  const pattern = PATTERNS[variant] || PATTERNS.Drive;
  return (
    <span className={`vr-pixel ${className}`.trim()} aria-hidden="true">
      {pattern.delays.map((delay, index) => (
        <i
          key={index}
          className="vr-pixel__cell"
          style={{ animationDuration: `${pattern.duration}ms`, animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}
