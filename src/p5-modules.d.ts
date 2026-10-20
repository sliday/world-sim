// p5 publishes its modular entry points without types. The core shares the full build's API, and
// each module entry registers its functions on the p5 class it is given.
declare module "p5/core" {
  import p5 from "p5";
  export default p5;
}

declare module "p5/accessibility" {
  const register: (p5: typeof import("p5").default) => void;
  export default register;
}

declare module "p5/color" {
  const register: (p5: typeof import("p5").default) => void;
  export default register;
}

declare module "p5/events" {
  const register: (p5: typeof import("p5").default) => void;
  export default register;
}

declare module "p5/image" {
  const register: (p5: typeof import("p5").default) => void;
  export default register;
}

declare module "p5/math" {
  const register: (p5: typeof import("p5").default) => void;
  export default register;
}

declare module "p5/shape" {
  const register: (p5: typeof import("p5").default) => void;
  export default register;
}

declare module "p5/type" {
  const register: (p5: typeof import("p5").default) => void;
  export default register;
}

declare module "p5/utilities" {
  const register: (p5: typeof import("p5").default) => void;
  export default register;
}
