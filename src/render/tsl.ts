// three's TSL typings model node types with generics that reject many valid
// compositions (for example passing a generic Node where a scalar is expected).
// Shader code imports TSL through this untyped view; everything else stays strict.
import * as TSL from 'three/tsl';

export const T: any = TSL;
export type N = any;
