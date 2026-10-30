// AI 生成的 3D 模型（GLB 文件，带骨骼）做宠物时的公共部分：按需加载模型、换成毛绒材质、
// 记下每根骨头的静止姿态、按"模型坐标里的轴"转骨头、鼠标命中检测用的隐形椭球、影子 / 牌子 / 水杯道具。
// 四足动物见 GltfQuadrupedModel，金鱼见 GltfFishModel；模型的制作流程见 docs/3D模型制作流程.md
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createDefaultPose, type CatPose } from '../BlackCatModel';
import { CupProp, ModelBuilder, SignProp } from './modelToolkit';
import type { PetModel, PetPose } from './PetModel';
import type { PetSkin } from '../skins';

export const MODEL_AXIS_X = new THREE.Vector3(1, 0, 0);
export const MODEL_AXIS_Y = new THREE.Vector3(0, 1, 0);
export const MODEL_AXIS_Z = new THREE.Vector3(0, 0, 1);
/** 默认的绒光颜色：偏冷的灰蓝（黑猫用） */
const DEFAULT_SHEEN_COLOR = 0x5c6684;

/**
 * 同一个文件只下载、解析一次，每只宠物各自克隆一份（蒙皮模型要用 SkeletonUtils 克隆，骨骼才是独立的）。
 * 加载器按需引入：只有选了 AI 皮肤才下载，代码版宠物的页面不会变大
 */
const gltfCache = new Map<string, Promise<GLTF>>();
async function loadGltfCopy(url: string): Promise<THREE.Object3D> {
  let promise = gltfCache.get(url);
  if (!promise) {
    promise = import('three/examples/jsm/loaders/GLTFLoader.js').then(({ GLTFLoader }) => new GLTFLoader().loadAsync(url));
    gltfCache.set(url, promise);
  }
  const [gltf, { clone }] = await Promise.all([promise, import('three/examples/jsm/utils/SkeletonUtils.js')]);
  return clone(gltf.scene);
}

/**
 * 毛绒材质：AI 生成的模型默认很光滑（Tripo 给的粗糙度只有 0.25，像塑料皮球）。
 * 换成哑光 + 绒光（sheen，表现天鹅绒、毛绒玩具边缘那层柔光），正面不再有亮斑，边缘透出毛茸茸的感觉。
 * 颜色、法线贴图沿用模型自带的；roughness 是整体粗糙度（金鱼比毛绒动物光滑一点）
 */
function createFurMaterial(source: THREE.Material | THREE.Material[], sheenColor: number, roughness: number): THREE.Material | THREE.Material[] {
  if (Array.isArray(source)) return source.map(item => createFurMaterial(item, sheenColor, roughness) as THREE.Material);
  if (!(source instanceof THREE.MeshStandardMaterial)) return source;
  const fur = new THREE.MeshPhysicalMaterial({
    map: source.map,
    normalMap: source.normalMap,
    normalScale: source.normalScale,
    roughness,
    metalness: 0,
    sheen: 1,
    sheenRoughness: .75,
    sheenColor: new THREE.Color(sheenColor),
  });
  source.dispose();
  return fur;
}

/** 一根骨头的静止姿态，以及把"模型坐标里的旋转轴"换算到它父节点坐标里需要的信息 */
export interface BoneRig {
  bone: THREE.Bone;
  restQuaternion: THREE.Quaternion;
  restPosition: THREE.Vector3;
  /** 父节点（静止时）在模型坐标里的朝向的逆：模型坐标的轴乘上它，就变成父节点坐标里的轴 */
  parentRestInverse: THREE.Quaternion;
  /** 父节点（静止时）在模型坐标里的缩放：位移要除以它 */
  parentRestScale: number;
  /** 骨头静止时在模型坐标里的方向（从头指向第一个子骨头；没有子骨头就沿自己的 y 轴） */
  restDirection: THREE.Vector3;
  /** 骨头的起点静止时在模型坐标里的位置（没乘放大倍数） */
  restModelPosition: THREE.Vector3;
}

export interface GltfModelOptions {
  /** 模型文件地址（public 目录下，例如 models/black_cat.glb） */
  file: string;
  /** 放大倍数：让模型和代码版宠物差不多大 */
  scale: number;
  /** 毛绒材质边缘绒光的颜色：深色毛用偏冷的灰蓝，橘色、奶色毛用暖色，否则会发灰（默认是黑猫用的灰蓝） */
  sheenColor?: number;
  /**
   * 尾巴跟着 tailLift 抬起 / 放下的程度（0~1，默认 1，只有四足动物用）。柴犬那种一直卷在背上的尾巴要设小，
   * 否则大脑让尾巴放低时（坐着、睡觉）毛球会垂到地上
   */
  tailLiftScale?: number;
}

/** 影子、牌子、水杯放在哪儿（每种动物身材不一样） */
export interface PropLayout {
  shadowSize: [number, number];
  shadowZ: number;
  signPosition: THREE.Vector3;
  cupPosition: THREE.Vector3;
  /** 材质整体粗糙度（毛绒动物 1，金鱼小一点） */
  roughness: number;
}

export abstract class GltfPetModelBase implements PetModel {
  readonly root = new THREE.Group();
  protected readonly currentPose: CatPose = createDefaultPose();
  /** 模型挂在这里，按放大倍数缩放 */
  protected readonly holder = new THREE.Group();
  protected readonly shadow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  protected readonly sign = new SignProp();
  protected readonly cup: CupProp;
  protected bones: Record<string, BoneRig> = {};
  /** 模型加载好、必要的骨头都在 */
  protected isLoaded = false;
  private isDisposed = false;

  // 每帧复用的临时对象，避免频繁创建
  private readonly tempQuaternion = new THREE.Quaternion();
  private readonly deltaQuaternion = new THREE.Quaternion();
  private readonly tempAxis = new THREE.Vector3();
  protected readonly tempOffset = new THREE.Vector3();

  constructor(skin: PetSkin, protected readonly options: GltfModelOptions, layout: PropLayout) {
    const builder = new ModelBuilder({ outlineColor: 0x060609, outlineThickness: .022, rimColor: 0x9fb6ff });
    this.shadow = builder.shadow(...layout.shadowSize);
    this.shadow.position.z = layout.shadowZ;
    this.cup = new CupProp(builder, layout.cupPosition);
    this.sign.group.position.copy(layout.signPosition);
    this.holder.scale.setScalar(options.scale);
    this.root.add(this.shadow, this.holder, this.sign.group, this.cup.group);
    this.root.name = `gltf-${skin.id}`;

    const url = `${import.meta.env.BASE_URL}${options.file}`;
    loadGltfCopy(url)
      .then(scene => { if (!this.isDisposed) this.attachModel(scene, layout.roughness); })
      .catch(error => {
        // 加载失败时把缓存清掉，下次换回这套皮肤会重新加载
        gltfCache.delete(url);
        console.error(`宠物模型加载失败：${options.file}`, error);
      });
  }

  /** 模型加载完、骨头都记下来之后调用：子类在这里找自己要的骨头，返回必要的骨头是否齐全 */
  protected abstract onModelLoaded(): boolean;

  abstract update(targetPose: PetPose, walkPhase: number, elapsedSeconds: number, deltaSeconds: number): void;

  /** 模型加载完：挂到场景里，换材质，记下每根骨头的静止姿态，挂上点击用的隐形椭球 */
  private attachModel(scene: THREE.Object3D, roughness: number): void {
    this.holder.add(scene);
    scene.updateMatrixWorld(true);
    const sceneInverse = scene.matrixWorld.clone().invert();
    const modelMatrixOf = (object: THREE.Object3D) => sceneInverse.clone().multiply(object.matrixWorld);
    const sheenColor = this.options.sheenColor ?? DEFAULT_SHEEN_COLOR;

    scene.traverse(object => {
      if (object instanceof THREE.Mesh) {
        object.frustumCulled = false;   // 蒙皮网格的包围盒不跟着骨骼动，关掉裁剪免得动作大时被裁掉
        object.material = createFurMaterial(object.material, sheenColor, roughness);
      }
      if (!(object instanceof THREE.Bone)) return;
      const parentMatrix = object.parent ? modelMatrixOf(object.parent) : new THREE.Matrix4();
      const parentPosition = new THREE.Vector3(), parentQuaternion = new THREE.Quaternion(), parentScale = new THREE.Vector3();
      parentMatrix.decompose(parentPosition, parentQuaternion, parentScale);
      // 骨头方向：自己的原点指向第一个子骨头（没有子骨头就沿自己的 y 轴，Blender 导出的骨头沿 y 轴）
      const head = new THREE.Vector3().setFromMatrixPosition(modelMatrixOf(object));
      const child = object.children.find(item => item instanceof THREE.Bone);
      const direction = child
        ? new THREE.Vector3().setFromMatrixPosition(modelMatrixOf(child)).sub(head)
        : new THREE.Vector3(0, 1, 0).transformDirection(modelMatrixOf(object));
      this.bones[object.name] = {
        bone: object,
        restQuaternion: object.quaternion.clone(),
        restPosition: object.position.clone(),
        parentRestInverse: parentQuaternion.invert(),
        parentRestScale: parentScale.x,
        restDirection: direction.normalize(),
        restModelPosition: head,
      };
    });

    this.isLoaded = this.onModelLoaded();
    if (!this.isLoaded) console.error(`宠物模型缺少必要的骨骼：${this.options.file}`, Object.keys(this.bones));
    scene.traverse(object => { if (object instanceof THREE.SkinnedMesh) this.addHitProxies(object); });
  }

  /**
   * 鼠标命中检测用的隐形椭球：每根骨头挂一个，大小是这根骨头主要带动的那部分网格的范围。
   * 直接对蒙皮网格做射线检测要先在 CPU 上把 1 万个三角形按骨骼变形一遍，实测一次 33 毫秒（代码版只要 1 毫秒），
   * 拖动、右键都会卡；椭球跟着骨头动，坐着、趴着也照样点得准
   */
  private addHitProxies(mesh: THREE.SkinnedMesh): void {
    mesh.raycast = () => {};
    const { position, skinIndex, skinWeight } = mesh.geometry.attributes;
    const bones = mesh.skeleton.bones;
    const pointsPerBone: THREE.Vector3[][] = bones.map(() => []);
    const toBoneSpace = bones.map((_bone, index) => mesh.skeleton.boneInverses[index].clone().multiply(mesh.bindMatrix));
    for (let index = 0; index < position.count; index++) {
      // 这个顶点主要跟着哪根骨头动
      let dominantBone = 0, dominantWeight = 0;
      for (let slot = 0; slot < 4; slot++) {
        const weight = skinWeight.getComponent(index, slot);
        if (weight > dominantWeight) { dominantWeight = weight; dominantBone = skinIndex.getComponent(index, slot); }
      }
      pointsPerBone[dominantBone].push(new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(toBoneSpace[dominantBone]));
    }
    // 每个方向去掉两头各 3% 的顶点：胡须这种细长的东西会把范围撑得很大
    const boxes = pointsPerBone.map(points => {
      const box = new THREE.Box3();
      if (points.length < 8) return box;
      for (const axis of ['x', 'y', 'z'] as const) {
        const values = points.map(point => point[axis]).sort((a, b) => a - b);
        box.min[axis] = values[Math.floor(values.length * .03)];
        box.max[axis] = values[Math.ceil(values.length * .97) - 1];
      }
      return box;
    });
    // 用盒子里面的椭球而不是盒子本身：宠物是圆滚滚的，方盒子的四个角会把旁边的空白也算成"点中了"，挡住后面的桌面
    const proxyMaterial = new THREE.MeshBasicMaterial({ visible: false });
    const proxyGeometry = new THREE.SphereGeometry(.5, 12, 8);
    boxes.forEach((box, index) => {
      if (box.isEmpty()) return;
      const proxy = new THREE.Mesh(proxyGeometry, proxyMaterial);
      box.getSize(proxy.scale);
      box.getCenter(proxy.position);
      bones[index].add(proxy);
    });
  }

  /**
   * 把一根骨头设成"静止姿态 + 一串旋转"。旋转轴用模型坐标写（x 轴＝前后摆，y 轴＝左右转，z 轴＝侧倾），
   * 和代码版模型里 Group.rotation 的含义一样（代码版的关节组在静止时都和模型坐标轴对齐）
   */
  protected poseBone(rig: BoneRig | undefined, rotations: [THREE.Vector3, number][]): void {
    if (!rig) return;
    this.deltaQuaternion.identity();
    for (const [modelAxis, angle] of rotations) {
      if (!angle) continue;
      this.tempAxis.copy(modelAxis).applyQuaternion(rig.parentRestInverse);
      this.deltaQuaternion.multiply(this.tempQuaternion.setFromAxisAngle(this.tempAxis, angle));
    }
    rig.bone.quaternion.copy(this.deltaQuaternion).multiply(rig.restQuaternion);
  }

  /** 把一根骨头在模型坐标里平移 offset（已经乘过放大倍数的长度），在 restPosition 基础上累加到 bone.position */
  protected offsetBone(rig: BoneRig, offset: THREE.Vector3): void {
    this.tempOffset.copy(offset).divideScalar(this.holder.scale.x).applyQuaternion(rig.parentRestInverse).divideScalar(rig.parentRestScale);
    rig.bone.position.add(this.tempOffset);
  }

  setSignText(text: string): void {
    this.sign.setText(text);
  }

  /** 装扮还没有挂到 AI 模型上（需要按每个模型的头部大小单独摆位置），先不显示 */
  setAccessory(_id: string): void {}

  /** 换掉这只宠物时调用：如果模型还没加载完，加载完也不再挂上去 */
  dispose(): void {
    this.isDisposed = true;
  }
}
