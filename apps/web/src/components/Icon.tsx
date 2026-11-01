const paths = {
  more: "M5 12h.01M12 12h.01M19 12h.01",
  chat: "M21 11a8 8 0 0 1-8 8H7l-4 3V11a9 9 0 0 1 18 0Z",
  settings: "M4 7h16M4 17h16M9 4v6M15 14v6",
  clock: "M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  history: "M3 4v5h5M3 9a9 9 0 1 1 0 6M12 7v5l3 2",
  panel: "M15 4v16M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
  lock: "M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5Z",
  edit: "m14 5 5 5M4 20l1-6L16 3l5 5L10 19Z",
  archive: "M4 8h16v13H4ZM3 3h18v5H3ZM9 12h6",
  refresh: "M20 4v6h-6M4 20v-6h6M4 9a8 8 0 0 1 14-5M20 15a8 8 0 0 1-14 5",
  file: "M14 3H5v18h14V8ZM14 3v5h5M8 13h8M8 17h5",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
  arrow: "M12 19V5m-6 6 6-6 6 6",
  close: "m6 6 12 12M6 18 18 6",
  connection: "M8 8 5 11a4 4 0 0 0 6 6l3-3M16 16l3-3a4 4 0 0 0-6-6l-3 3M9 15l6-6",
};

export function Icon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      className="ui-icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "more" ? 3 : 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
