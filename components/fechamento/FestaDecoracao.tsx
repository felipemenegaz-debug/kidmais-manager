import styles from "./FestaDecoracao.module.css";

// Marcas d'água decorativas: nunca recebem foco nem interceptam a seleção da agenda.
export default function FestaDecoracao() {
  return (
    <div className={styles.scene} aria-hidden="true">
      {["left", "right"].map((lado) => (
        <svg key={lado} className={lado === "left" ? styles.left : styles.right} viewBox="0 0 180 440" fill="none" focusable="false">
          <ellipse cx="66" cy="115" rx="40" ry="49" fill="#ada3ec" />
          <path d="m66 161-6 10h12ZM66 171c-24 35 25 60 0 101s12 59 8 86" stroke="#a79acb" strokeWidth="2" />
          <ellipse cx="121" cy="201" rx="32" ry="39" fill="#edc391" />
          <path d="m121 238-5 8h10ZM121 246c20 30-22 65-6 112" stroke="#d3bba6" strokeWidth="2" />
          <path d="m40 20 6 13m97 53 10-7M20 226l8-6m124 148 8 9M51 395l-8 10" stroke="#b2bde9" strokeWidth="5" strokeLinecap="round" />
          <path d="m112 33 6 10m-91 286 8 5M154 290l-6 9" stroke="#e6bd91" strokeWidth="5" strokeLinecap="round" />
          <circle cx="27" cy="59" r="4" fill="#c9b2de" /><circle cx="152" cy="131" r="4" fill="#c9b2de" />
        </svg>
      ))}
    </div>
  );
}
