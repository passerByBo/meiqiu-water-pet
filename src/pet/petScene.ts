// 3D 场景：渲染器、相机、灯光、黑猫模型，以及"鼠标是否点在猫身上"的射线检测
import * as THREE from 'three';
import { BlackCatModel } from './BlackCatModel';
import { CAT_CANVAS_SIZE } from './constants';
import type { Point } from '../shared/geometry';

export class PetScene {
  readonly catModel = new BlackCatModel();
  /** 脚底中心（世界坐标原点）投影到画布上的像素位置，用来把猫对齐到它在桌面上的位置 */
  readonly groundPointOnCanvas: Point;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(26, 1, .1, 50);
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(CAT_CANVAS_SIZE, CAT_CANVAS_SIZE);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.camera.position.set(0, 2.15, 5.5);
    this.camera.lookAt(0, .64, 0);
    this.camera.updateMatrixWorld(); // lookAt 之后要先更新矩阵，否则投影结果不对

    // 灯光：主光 + 两盏轮廓光（让黑猫在任何壁纸上都有清晰的边缘）
    this.scene.add(new THREE.HemisphereLight(0xe2ebff, 0x2a241e, 1.0));
    const keyLight = new THREE.DirectionalLight(0xfff2e0, 2.4);
    keyLight.position.set(2.5, 4, 3.5);
    const rimLightLeft = new THREE.DirectionalLight(0xc4d8ff, 3.2);
    rimLightLeft.position.set(-3, 2.5, -3.5);
    const rimLightRight = new THREE.DirectionalLight(0xffe2c4, 1.8);
    rimLightRight.position.set(3.2, 1.6, -3);
    this.scene.add(keyLight, rimLightLeft, rimLightRight);
    this.scene.add(this.catModel.root);

    const projected = new THREE.Vector3(0, 0, 0).project(this.camera);
    this.groundPointOnCanvas = {
      x: (projected.x + 1) / 2 * CAT_CANVAS_SIZE,
      y: (1 - projected.y) / 2 * CAT_CANVAS_SIZE,
    };
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /** 画布内坐标 (canvasX, canvasY) 是否点在猫身上 */
  hitTest(canvasX: number, canvasY: number): boolean {
    if (canvasX < 0 || canvasY < 0 || canvasX > CAT_CANVAS_SIZE || canvasY > CAT_CANVAS_SIZE) return false;
    this.pointerNdc.set(canvasX / CAT_CANVAS_SIZE * 2 - 1, -(canvasY / CAT_CANVAS_SIZE * 2 - 1));
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    return this.raycaster.intersectObject(this.catModel.root, true).length > 0;
  }
}
