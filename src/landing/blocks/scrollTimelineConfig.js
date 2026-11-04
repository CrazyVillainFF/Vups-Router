// One entry per section that actually exists in LandingPage.jsx, in the order
// they appear in the DOM. The choreography names from the brief map onto the
// real ids; nothing was renamed, reordered or invented to fit the film.
//
//   hero         -> #top        01 what it is   -> #overview   02 what it fixes -> #problems
//   03 interface -> #showcase   04 capabilities -> #features   05 model choice  -> #models
//   07 journey   -> #flow       09 privacy      -> #privacy    12 start         -> #start
//
// #use-cases, #craft, #get-started and #faq are real sections the brief never
// mentions. They hold the previous composition instead of getting a stage of
// their own, which keeps their content readable and the film continuous.

export const scrollTimelineConfig = {
  hero: {
    id: "top",
    trigger: "#top",
    start: "top top",
    end: "bottom top",
    duration: 1,
    scrub: 1,
    arrangement: "cluster",
    camera: { x: 0, y: 0.55, z: 7.4, lookY: -0.2 },
    transition: { ease: "power2.out", blend: 0.5 }
  },
  whatItIs: {
    id: "overview",
    trigger: "#overview",
    start: "top 82%",
    end: "bottom 24%",
    duration: 1,
    scrub: 1,
    arrangement: "scatter",
    camera: { x: 0, y: 0.7, z: 8.6, lookY: -0.1 },
    transition: { ease: "power2.out", blend: 0.5 }
  },
  whatItFixes: {
    id: "problems",
    trigger: "#problems",
    start: "top 82%",
    end: "bottom 24%",
    duration: 1,
    scrub: 1,
    arrangement: "grid",
    routedLine: true,
    camera: { x: 0, y: 0.5, z: 8.2, lookY: -0.15 },
    transition: { ease: "power2.out", blend: 0.5 }
  },
  interface: {
    id: "showcase",
    trigger: "#showcase",
    start: "top 80%",
    end: "bottom 22%",
    duration: 1,
    scrub: 1,
    arrangement: "pullback",
    device: true,
    camera: { x: 0, y: 0.4, z: 9.4, lookY: 0 },
    transition: { ease: "power2.out", blend: 0.45 }
  },
  capabilities: {
    id: "features",
    trigger: "#features",
    start: "top 80%",
    end: "bottom 22%",
    duration: 1,
    scrub: 1,
    arrangement: "shelf",
    camera: { x: 0, y: 0.6, z: 8.4, lookY: -0.1 },
    transition: { ease: "power2.out", blend: 0.45 }
  },
  modelChoice: {
    id: "models",
    trigger: "#models",
    start: "top top",
    end: "+=240%",
    duration: 1,
    scrub: 1,
    pin: true,
    arrangement: "row",
    camera: { x: 0, y: 0.3, z: 7.5, lookY: -0.1 },
    transition: { ease: "power2.out", blend: 0.4 }
  },
  useCases: {
    id: "use-cases",
    trigger: "#use-cases",
    start: "top 84%",
    end: "bottom 30%",
    duration: 1,
    scrub: 1,
    hold: "modelChoice",
    camera: { x: 0, y: 0.3, z: 7.5, lookY: -0.1 },
    transition: { ease: "power2.out", blend: 0.4 }
  },
  journey: {
    id: "flow",
    trigger: "#flow",
    start: "top 78%",
    end: "bottom 26%",
    duration: 1,
    scrub: 1,
    arrangement: "corridor",
    promptCube: true,
    routerGate: true,
    camera: { x: 0, y: 0.2, z: 6.2, lookY: -0.25 },
    transition: { ease: "power2.out", blend: 0.4 }
  },
  usability: {
    id: "craft",
    trigger: "#craft",
    start: "top 84%",
    end: "bottom 30%",
    duration: 1,
    scrub: 1,
    hold: "journey",
    camera: { x: 0, y: 0.2, z: 6.2, lookY: -0.25 },
    transition: { ease: "power2.out", blend: 0.4 }
  },
  privacy: {
    id: "privacy",
    trigger: "#privacy",
    start: "top 80%",
    end: "bottom 24%",
    duration: 1,
    scrub: 1,
    arrangement: "vault",
    camera: { x: 0, y: 0.35, z: 7.8, lookY: -0.15 },
    transition: { ease: "power2.out", blend: 0.5 }
  },
  gettingIn: {
    id: "get-started",
    trigger: "#get-started",
    start: "top 84%",
    end: "bottom 30%",
    duration: 1,
    scrub: 1,
    hold: "privacy",
    camera: { x: 0, y: 0.35, z: 7.8, lookY: -0.15 },
    transition: { ease: "power2.out", blend: 0.5 }
  },
  questions: {
    id: "faq",
    trigger: "#faq",
    start: "top 84%",
    end: "bottom 30%",
    duration: 1,
    scrub: 1,
    hold: "privacy",
    camera: { x: 0, y: 0.35, z: 7.8, lookY: -0.15 },
    transition: { ease: "power2.out", blend: 0.5 }
  },
  start: {
    id: "start",
    trigger: "#start",
    start: "top 76%",
    end: "bottom bottom",
    duration: 1,
    scrub: 1,
    arrangement: "brandmark",
    turntable: true,
    camera: { x: 0, y: 0.2, z: 7.2, lookY: -0.1 },
    transition: { ease: "power2.out", blend: 0.55 }
  }
};

export const stageSectionOrder = Object.keys(scrollTimelineConfig);

export function stageConfigFor(id) {
  return Object.values(scrollTimelineConfig).find(entry => entry.id === id) || null;
}
