export type Vec3 = [number, number, number];

export type HeadShape = 'egg' | 'block' | 'round' | 'visor';
export type HandPose = 'fist' | 'open' | 'grip';
export type Emblem = 'none' | 'chevron' | 'circle' | 'bar';
export type Weapon = 'none' | 'sword' | 'staff';

/** Joint-to-joint distances in mm at scale 1. */
export type Proportions = {
  hipHalf: number;      // pelvis centre -> hip ball (x)
  waistLen: number;     // pelvis ball -> waist ball
  abdomenLen: number;   // waist ball -> chest pivot
  chestLen: number;     // chest pivot -> neck socket
  shoulderY: number;    // chest pivot -> shoulder axis (y)
  shoulderHalf: number; // centre -> shoulder ball (x)
  neckLen: number;      // neck ball -> neck ball
  thighLen: number;     // hip swivel disc -> knee pin
  shinLen: number;      // knee pin -> ankle ball
  upperArmLen: number;  // shoulder swivel disc -> elbow pin
  forearmLen: number;   // elbow pin -> wrist ball
};

export type ArmorToggles = {
  head: boolean;
  chest: boolean;
  abdomen: boolean;
  pelvis: boolean;
  arms: boolean;
  legs: boolean;
  feet: boolean;
};

export type Style = {
  headShape: HeadShape;
  headSize: number;   // multiplier
  chestWidth: number; // multiplier
  bulk: number;       // limb armor multiplier
  facet: number;      // 0..1 chamfer amount
  emblem: Emblem;
  handPose: HandPose;
  weapon: Weapon;      // held in the right hand (needs grip hands)
  handSize: number;
  footSize: number;
  ankleTilt: number;  // degrees
  backPort: boolean;
  armor: ArmorToggles;
};

/** Absolute fit values in mm. They never scale with the figure. */
export type Tolerances = {
  socketSpine: number; // diametral interference, spine ball joints
  socketLimb: number;  // diametral interference, limb ball joints
  hinge: number;       // radial interference of the clip ridge in the pin groove
  swivel: number;      // leaf-spring preload on the swivel disc
  armor: number;       // radial clearance armor <-> frame
  peg: number;         // diametral interference of armor pegs
  slide: number;       // clearance for sliding fits (swivel chamber, mortise)
};

/** Character skin: armor shapes taken from an imported model. */
export type SkinSettings = {
  enabled: boolean;
  modelId: string;   // content hash of the imported model ('' = none)
  modelName: string;
  transform: { scale: number; rot: Vec3; offset: Vec3 }; // model -> figure (bind pose) space
  bindPose: Pose;     // pose the model is standing in
  detail: number;     // voxel size, mm
  close: number;      // seal openings narrower than ~2x this, mm
  gap: number;        // gap between neighbouring skin pieces, mm
};

export type FigureSpec = {
  version: 1;
  name: string;
  scale: number;
  material: string;
  proportions: Proportions;
  style: Style;
  tolerances: Tolerances;
  skin: SkinSettings;
};

/** Joint angles in degrees: [x, y, z]. Hinges use x, swivels use y. */
export type Pose = Record<string, Vec3>;

export type PrintSettings = {
  bedX: number;
  bedY: number;
  spacing: number;
  stand: boolean;
};

export type Colors = {
  frame: string;
  armor: string;
  background: string;
};

export type PartGroup = 'frame' | 'armor' | 'accessory';

/** Mesh payload passed from the geometry worker. Coordinates are in the part's design frame. */
export type MeshData = {
  positions: Float32Array;
  indices: Uint32Array;
  volume: number;
};
