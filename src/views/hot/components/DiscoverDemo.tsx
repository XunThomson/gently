import {useEffect, useId, useRef} from 'react';
import {useTranslation} from 'react-i18next';
import * as THREE from 'three';
import {Reflector} from 'three/examples/jsm/objects/Reflector.js';
import {useSelect} from '../../../store';
import styles from './DiscoverDemo.module.css';

/**
 * 「发现」页的 3D 演示卡（R87 视觉稿）。
 *
 * 目标不是做一台可操作的唱机，而是复现参考照片的空间关系：
 * 暖色暗房里，黑胶在下方前景、专辑封面在后景直立，唱臂从右后方压到唱片上。
 *
 * 全部几何与贴图在运行时程序化生成（Canvas 2D），不加载任何外部图片；
 * 场景用 raw three.js（没有 R3F），生命周期严格跟随组件挂载：
 * ResizeObserver 适配容器、DPR 上限 2、卸载时释放 geometry/material/texture/renderer。
 *
 * 交互刻意做得很轻：
 * - 拖拽 = 在很小的角度范围内环绕（不会把唱机转到背面）；
 * - 指针位置 = 极轻微的视差；
 * - **不注册 wheel 监听**，滚轮滚动照常交给页面。
 *
 * 动效尊重 `prefers-reduced-motion`：开启后唱片不再自转。
 */

export interface DiscoverDemoProps {
    className?: string;
    /** 后续背景仓库的入口：图片/视频帧的 URL；不传就用当前曲目的封面 */
    backgroundUrl?: string;
}

/** 3D 材质的颜色允许用十六进制（CSS 仍然只消费主题 token）。 */
const COLOR = {
    plinth: 0x0b0a09,
    plinthTop: 0x151311,
    metal: 0xb8ad9c,
    darkMetal: 0x2a2724,
    vinyl: 0x08080a,
    vinylEdge: 0x2b2a29,
    wall: 0x1a100c,
    tableTint: 0x4a3226,
    keyLight: 0xffb374,
    rimLight: 0xff6a36,
    edgeLight: 0x6d7cff,
    glow: 0xff8a4a,
    dust: 0xffc58a,
} as const;

/** 封面版式：更窄的竖向色条（上→下渐变），只表达暖色印刷品，不使用任何现成封面。 */
const COVER_BLOCKS = [
    {x: 0.0, w: 0.06, top: '#2a1412', bottom: '#170b09'},
    {x: 0.06, w: 0.07, top: '#c95b31', bottom: '#7a2a1b'},
    {x: 0.13, w: 0.055, top: '#f0d7ae', bottom: '#cfa169'},
    {x: 0.185, w: 0.08, top: '#8e2f1f', bottom: '#571a13'},
    {x: 0.265, w: 0.06, top: '#e2a144', bottom: '#b46b25'},
    {x: 0.325, w: 0.075, top: '#d06a3b', bottom: '#8f3522'},
    {x: 0.4, w: 0.055, top: '#2a1512', bottom: '#140a09'},
    {x: 0.455, w: 0.075, top: '#b84a2a', bottom: '#6a2117'},
    {x: 0.53, w: 0.06, top: '#f0d7ae', bottom: '#d1a36b'},
    {x: 0.59, w: 0.07, top: '#8e2f1f', bottom: '#4f170f'},
    {x: 0.66, w: 0.06, top: '#e2a144', bottom: '#b46b25'},
    {x: 0.72, w: 0.08, top: '#c95b31', bottom: '#7a2a1b'},
    {x: 0.8, w: 0.055, top: '#2a1512', bottom: '#160b09'},
    {x: 0.855, w: 0.07, top: '#d06a3b', bottom: '#8f3522'},
    {x: 0.925, w: 0.075, top: '#f0d7ae', bottom: '#b88452'},
] as const;

const FONT_STACK = '"Helvetica Neue", "Segoe UI", Arial, sans-serif';

function seededRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0xffffffff;
    };
}

function createCanvas(width: number, height: number): {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
} {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    return {canvas, ctx};
}

function textureFromCanvas(
    renderer: THREE.WebGLRenderer,
    canvas: HTMLCanvasElement,
    options: {srgb?: boolean; repeat?: [number, number]} = {},
): THREE.CanvasTexture {
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = options.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    if (options.repeat) {
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.repeat.set(options.repeat[0], options.repeat[1]);
    }
    texture.needsUpdate = true;
    return texture;
}

/** 程序化专辑封面：窄竖条拼块 + 压到底部的大字排版 + 纸张颗粒。 */
function makeCoverTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
    const size = 1024;
    const {canvas, ctx} = createCanvas(size, size);

    ctx.fillStyle = '#1a0d0a';
    ctx.fillRect(0, 0, size, size);

    for (let index = 0; index < COVER_BLOCKS.length; index += 1) {
        const block = COVER_BLOCKS[index];
        const x = block.x * size;
        const width = block.w * size + 1;
        const gradient = ctx.createLinearGradient(0, 0, 0, size);
        gradient.addColorStop(0, block.top);
        gradient.addColorStop(1, block.bottom);
        ctx.fillStyle = gradient;
        ctx.fillRect(x, 0, width, size);

        /* 几刀横切：像拼贴印刷，而不是整齐的纯色柱 */
        if (index % 4 === 0) {
            ctx.fillStyle = 'rgba(244, 229, 201, 0.16)';
            ctx.fillRect(x, size * 0.16, width, size * 0.2);
        }
        if (index % 5 === 2) {
            ctx.fillStyle = 'rgba(18, 9, 7, 0.18)';
            ctx.fillRect(x, size * 0.42, width, size * 0.13);
        }
    }

    /* 顶部一条米色刊头，像真实封套上的印厂信息 */
    ctx.fillStyle = 'rgba(240, 223, 195, 0.9)';
    ctx.fillRect(0, 0, size, 26);

    /* 大圆环：只做图形节奏，不抢唱片的圆形主体 */
    ctx.strokeStyle = 'rgba(244, 229, 201, 0.55)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(size * 0.83, size * 0.27, size * 0.115, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(244, 229, 201, 0.9)';
    ctx.beginPath();
    ctx.arc(size * 0.83, size * 0.27, size * 0.014, 0, Math.PI * 2);
    ctx.fill();

    /* 底部压暗：让大字贴着底边仍然可读，同时保留竖条的方向感 */
    const bottomShade = ctx.createLinearGradient(0, size * 0.5, 0, size);
    bottomShade.addColorStop(0, 'rgba(17, 9, 7, 0)');
    bottomShade.addColorStop(0.42, 'rgba(17, 9, 7, 0.52)');
    bottomShade.addColorStop(1, 'rgba(17, 9, 7, 0.94)');
    ctx.fillStyle = bottomShade;
    ctx.fillRect(0, size * 0.5, size, size * 0.5);

    ctx.fillStyle = 'rgba(244, 229, 201, 0.55)';
    ctx.fillRect(68, 622, 888, 3);

    /* 大字排版：先量宽度再定字号，保证不溢出封套 */
    let titleSize = 214;
    for (;;) {
        ctx.font = `800 ${titleSize}px ${FONT_STACK}`;
        if (ctx.measureText('SLOW').width <= 866 || titleSize <= 120) break;
        titleSize -= 4;
    }
    ctx.font = `800 ${titleSize}px ${FONT_STACK}`;

    /* 套色偏移：先印橙色，再压米色，像旧唱片的轻微错版 */
    ctx.fillStyle = 'rgba(201, 91, 49, 0.66)';
    ctx.fillText('SLOW', 78, 838);
    ctx.fillText('SPIN', 78, 1006);
    ctx.fillStyle = '#f4e5c9';
    ctx.fillText('SLOW', 70, 830);
    ctx.fillText('SPIN', 70, 998);

    /* 顶部编辑型小字 */
    ctx.font = `600 23px ${FONT_STACK}`;
    ctx.fillStyle = '#2a1412';
    ctx.fillText('GENTLY RECORDS', 66, 82);
    ctx.textAlign = 'right';
    ctx.fillText('SIDE A · 001', 958, 82);
    ctx.textAlign = 'left';

    ctx.font = `500 17px ${FONT_STACK}`;
    ctx.fillStyle = 'rgba(244, 229, 201, 0.68)';
    ctx.fillText('ANALOG STUDY', 66, 116);

    /* 左侧竖排的小字：竖条之间的一条“侧脊” */
    ctx.save();
    ctx.translate(24, 986);
    ctx.rotate(-Math.PI / 2);
    ctx.font = `500 17px ${FONT_STACK}`;
    ctx.fillStyle = 'rgba(244, 229, 201, 0.6)';
    ctx.fillText('33⅓ RPM · STEREO', 0, 0);
    ctx.restore();

    /* 纸张颗粒 */
    const random = seededRandom(7);
    for (let i = 0; i < 16000; i += 1) {
        ctx.globalAlpha = 0.018 + random() * 0.05;
        ctx.fillStyle = random() > 0.5 ? '#ffffff' : '#000000';
        ctx.fillRect(random() * size, random() * size, 1.2, 1.2);
    }
    ctx.globalAlpha = 1;

    return textureFromCanvas(renderer, canvas);
}

/** 唱片中心标签 */
function makeLabelTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
    const size = 512;
    const {canvas, ctx} = createCanvas(size, size);

    ctx.fillStyle = '#b84a2a';
    ctx.fillRect(0, 0, size, size);

    ctx.strokeStyle = 'rgba(244, 229, 201, 0.65)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.45, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = '#f4e5c9';
    ctx.textAlign = 'center';
    ctx.font = `700 46px ${FONT_STACK}`;
    ctx.fillText('SLOW SPIN', size / 2, 164);
    ctx.font = `600 22px ${FONT_STACK}`;
    ctx.fillText('SIDE A', size / 2, 218);
    ctx.font = `500 18px ${FONT_STACK}`;
    ctx.fillText('33⅓ RPM', size / 2, 352);
    ctx.fillText('GENTLY', size / 2, 390);

    /* 中心孔（中轴会从中间穿过） */
    ctx.fillStyle = '#0a0808';
    ctx.beginPath();
    ctx.arc(size / 2, size / 2 + 8, 24, 0, Math.PI * 2);
    ctx.fill();

    ctx.textAlign = 'left';
    return textureFromCanvas(renderer, canvas);
}

/** 黑胶盘面：细密同心纹 + 两道柔和的弧形反光。 */
function makeGrooveTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
    const size = 1024;
    const {canvas, ctx} = createCanvas(size, size);
    const center = size / 2;

    ctx.fillStyle = '#09090b';
    ctx.fillRect(0, 0, size, size);

    for (let radius = 150, index = 0; radius < 500; radius += 2.2, index += 1) {
        ctx.beginPath();
        ctx.arc(center, center, radius, 0, Math.PI * 2);
        ctx.strokeStyle =
            index % 11 === 0
                ? 'rgba(255, 235, 210, 0.12)'
                : index % 4 === 0
                  ? 'rgba(255, 255, 255, 0.045)'
                  : 'rgba(0, 0, 0, 0.3)';
        ctx.lineWidth = index % 7 === 0 ? 1.6 : 1;
        ctx.stroke();
    }

    /* 径向的细碎反光，让盘面不是纯黑 */
    const random = seededRandom(21);
    for (let i = 0; i < 54; i += 1) {
        const angle = random() * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(center + Math.cos(angle) * 160, center + Math.sin(angle) * 160);
        ctx.lineTo(center + Math.cos(angle) * 495, center + Math.sin(angle) * 495);
        ctx.strokeStyle = `rgba(255, 208, 160, ${0.012 + random() * 0.025})`;
        ctx.lineWidth = 1 + random() * 3;
        ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(255, 198, 150, 0.08)';
    ctx.lineWidth = 42;
    ctx.beginPath();
    ctx.arc(center, center, 378, -2.65, -1.45);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.035)';
    ctx.lineWidth = 88;
    ctx.beginPath();
    ctx.arc(center, center, 430, 0.45, 1.4);
    ctx.stroke();

    return textureFromCanvas(renderer, canvas);
}

/** 转盘边缘的细密滚花：用 360 根竖线模拟一圈高光。 */
function makeKnurlTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
    const width = 2048;
    const height = 64;
    const {canvas, ctx} = createCanvas(width, height);
    const random = seededRandom(99);

    ctx.fillStyle = '#0c0c0d';
    ctx.fillRect(0, 0, width, height);

    for (let i = 0; i < 360; i += 1) {
        const x = (i / 360) * width;
        const alpha = i % 18 === 0 ? 0.55 + random() * 0.25 : 0.12 + random() * 0.3;
        ctx.fillStyle = `rgba(214, 199, 176, ${alpha})`;
        ctx.fillRect(x, 0, i % 18 === 0 ? 2 : 1, height);
    }

    const sheen = ctx.createLinearGradient(0, 0, 0, height);
    sheen.addColorStop(0, 'rgba(255, 255, 255, 0.08)');
    sheen.addColorStop(0.45, 'rgba(255, 255, 255, 0)');
    sheen.addColorStop(1, 'rgba(0, 0, 0, 0.22)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, width, height);

    return textureFromCanvas(renderer, canvas);
}

/** 桌面木纹（叠在半透明反射上，避免整张桌子像一块镜子）。 */
function makeWoodTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
    const width = 1024;
    const height = 512;
    const {canvas, ctx} = createCanvas(width, height);
    const random = seededRandom(33);

    const base = ctx.createLinearGradient(0, 0, 0, height);
    base.addColorStop(0, '#2b1a12');
    base.addColorStop(0.5, '#22140e');
    base.addColorStop(1, '#160d09');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, width, height);

    for (let i = 0; i < 170; i += 1) {
        const baseY = (i / 170) * height + (random() - 0.5) * 10;
        ctx.beginPath();
        for (let x = 0; x <= width; x += 16) {
            const y = baseY + Math.sin(x * 0.007 + i * 1.7) * 3 + Math.sin(x * 0.021 + i) * 1.2;
            if (x === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.strokeStyle =
            i % 9 === 0 ? 'rgba(146, 96, 59, 0.17)' : 'rgba(10, 5, 3, 0.24)';
        ctx.lineWidth = i % 13 === 0 ? 2.4 : 1;
        ctx.stroke();
    }

    for (let i = 0; i < 4; i += 1) {
        const x = random() * width;
        const y = random() * height;
        const radius = 18 + random() * 42;
        const knot = ctx.createRadialGradient(x, y, 0, x, y, radius);
        knot.addColorStop(0, 'rgba(8, 4, 2, 0.5)');
        knot.addColorStop(0.55, 'rgba(30, 16, 9, 0.25)');
        knot.addColorStop(1, 'rgba(30, 16, 9, 0)');
        ctx.fillStyle = knot;
        ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }

    return textureFromCanvas(renderer, canvas, {repeat: [3, 2]});
}

/** 接触阴影 / 环境遮蔽用的软椭圆。 */
function makeContactTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
    const size = 256;
    const {canvas, ctx} = createCanvas(size, size);
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(0, 0, 0, 0.88)');
    gradient.addColorStop(0.45, 'rgba(0, 0, 0, 0.42)');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    return textureFromCanvas(renderer, canvas);
}

/** 暖色光晕 / 灰尘颗粒用的径向白色贴图（颜色由材质 tint 决定）。 */
function makeGlowTexture(renderer: THREE.WebGLRenderer, hard = false): THREE.CanvasTexture {
    const size = hard ? 64 : 256;
    const {canvas, ctx} = createCanvas(size, size);
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
    gradient.addColorStop(hard ? 0.32 : 0.22, 'rgba(255, 255, 255, 0.72)');
    gradient.addColorStop(hard ? 0.6 : 0.6, 'rgba(255, 255, 255, 0.14)');
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    return textureFromCanvas(renderer, canvas);
}

/**
 * 程序化环境贴图：暖色暗房里几块柔光，作为金属 / 黑胶的反射源。
 * 不依赖 HDR 文件，也不需要网络。
 */
function makeEnvironmentTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
    const width = 1024;
    const height = 512;
    const {canvas, ctx} = createCanvas(width, height);

    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, '#1a0e09');
    sky.addColorStop(0.52, '#0c0705');
    sky.addColorStop(1, '#040302');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);

    const blobs: Array<[number, number, number, string]> = [
        [0.2, 0.56, 0.16, 'rgba(255, 186, 126, 0.88)'],
        [0.72, 0.38, 0.11, 'rgba(255, 106, 54, 0.62)'],
        [0.52, 0.72, 0.2, 'rgba(126, 80, 52, 0.42)'],
        [0.9, 0.5, 0.08, 'rgba(109, 124, 255, 0.3)'],
    ];
    for (const [x, y, radius, color] of blobs) {
        const gradient = ctx.createRadialGradient(
            x * width,
            y * height,
            0,
            x * width,
            y * height,
            radius * width,
        );
        gradient.addColorStop(0, color);
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);
    }

    /* 一条低低的水平亮带：在金属边缘拉出细长高光 */
    const strip = ctx.createLinearGradient(0, height * 0.58, 0, height * 0.66);
    strip.addColorStop(0, 'rgba(255, 206, 158, 0)');
    strip.addColorStop(0.5, 'rgba(255, 206, 158, 0.42)');
    strip.addColorStop(1, 'rgba(255, 206, 158, 0)');
    ctx.fillStyle = strip;
    ctx.fillRect(0, height * 0.58, width, height * 0.08);

    const texture = textureFromCanvas(renderer, canvas);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    return texture;
}

function roundedRectShape(width: number, depth: number, radius: number): THREE.Shape {
    const x = -width / 2;
    const y = -depth / 2;
    const r = Math.min(radius, width / 2, depth / 2);
    const shape = new THREE.Shape();
    shape.moveTo(x + r, y);
    shape.lineTo(x + width - r, y);
    shape.quadraticCurveTo(x + width, y, x + width, y + r);
    shape.lineTo(x + width, y + depth - r);
    shape.quadraticCurveTo(x + width, y + depth, x + width - r, y + depth);
    shape.lineTo(x + r, y + depth);
    shape.quadraticCurveTo(x, y + depth, x, y + depth - r);
    shape.lineTo(x, y + r);
    shape.quadraticCurveTo(x, y, x + r, y);
    return shape;
}

function cylinderBetween(
    start: THREE.Vector3,
    end: THREE.Vector3,
    radiusStart: number,
    radiusEnd: number,
    material: THREE.Material,
    radialSegments = 16,
): THREE.Mesh {
    const direction = new THREE.Vector3().subVectors(end, start);
    const length = direction.length();
    const geometry = new THREE.CylinderGeometry(
        radiusEnd,
        radiusStart,
        length,
        radialSegments,
        1,
        false,
    );
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(start).add(end).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    return mesh;
}

/** 唱机主体：底座 / 转盘 / 唱片 / 唱臂 / 控件。 */
function buildTurntable(renderer: THREE.WebGLRenderer): {
    group: THREE.Group;
    record: THREE.Group;
} {
    const group = new THREE.Group();

    const plinthMaterial = new THREE.MeshPhysicalMaterial({
        color: COLOR.plinth,
        metalness: 0.55,
        roughness: 0.34,
        clearcoat: 0.4,
        clearcoatRoughness: 0.34,
        envMapIntensity: 0.9,
    });
    const plinthShape = roundedRectShape(4.35, 3.4, 0.34);
    const plinthGeometry = new THREE.ExtrudeGeometry(plinthShape, {
        depth: 0.28,
        bevelEnabled: true,
        bevelThickness: 0.035,
        bevelSize: 0.035,
        bevelSegments: 4,
        curveSegments: 10,
    });
    plinthGeometry.rotateX(-Math.PI / 2);
    plinthGeometry.computeBoundingBox();
    const plinthBounds = plinthGeometry.boundingBox;
    const baseTop = plinthBounds ? plinthBounds.max.y - plinthBounds.min.y : 0.35;
    if (plinthBounds) plinthGeometry.translate(0, -plinthBounds.min.y, 0);

    const plinth = new THREE.Mesh(plinthGeometry, plinthMaterial);
    plinth.position.z = 0.2;
    plinth.castShadow = true;
    plinth.receiveShadow = true;
    group.add(plinth);

    /* 顶板接缝：给纯黑底座一点可读的层次 */
    const topGeometry = new THREE.ExtrudeGeometry(roundedRectShape(4.02, 3.06, 0.3), {
        depth: 0.012,
        bevelEnabled: false,
        curveSegments: 10,
    });
    topGeometry.rotateX(-Math.PI / 2);
    topGeometry.computeBoundingBox();
    if (topGeometry.boundingBox) topGeometry.translate(0, -topGeometry.boundingBox.min.y, 0);
    const topPlate = new THREE.Mesh(
        topGeometry,
        new THREE.MeshStandardMaterial({
            color: COLOR.plinthTop,
            metalness: 0.55,
            roughness: 0.46,
            envMapIntensity: 0.8,
        }),
    );
    topPlate.position.set(0, baseTop + 0.002, 0.2);
    topPlate.castShadow = true;
    topPlate.receiveShadow = true;
    group.add(topPlate);

    const silver = new THREE.MeshStandardMaterial({
        color: COLOR.metal,
        metalness: 1,
        roughness: 0.16,
        envMapIntensity: 1.15,
    });
    const darkSilver = new THREE.MeshStandardMaterial({
        color: 0x6d655b,
        metalness: 0.92,
        roughness: 0.28,
        envMapIntensity: 1,
    });

    /* 转盘 */
    const platterHeight = 0.22;
    const platterY = baseTop + platterHeight / 2;
    const platter = new THREE.Mesh(
        new THREE.CylinderGeometry(1.72, 1.74, platterHeight, 96),
        new THREE.MeshStandardMaterial({
            color: 0x161616,
            metalness: 0.86,
            roughness: 0.28,
            envMapIntensity: 1,
        }),
    );
    platter.position.set(0, platterY, 0.35);
    platter.castShadow = true;
    platter.receiveShadow = true;
    group.add(platter);

    const platterTopMaterial = new THREE.MeshStandardMaterial({
        color: 0x0e0e0f,
        metalness: 0.6,
        roughness: 0.38,
        envMapIntensity: 0.8,
    });
    const platterTop = new THREE.Mesh(new THREE.CircleGeometry(1.7, 96), platterTopMaterial);
    platterTop.rotation.x = -Math.PI / 2;
    platterTop.position.set(0, baseTop + platterHeight + 0.001, 0.35);
    platterTop.receiveShadow = true;
    group.add(platterTop);

    /* 转盘边缘：细密滚花 + 上下两道金属压边 */
    const knurlTexture = makeKnurlTexture(renderer);
    const knurl = new THREE.Mesh(
        new THREE.CylinderGeometry(1.735, 1.735, 0.15, 160, 1, true),
        new THREE.MeshStandardMaterial({
            map: knurlTexture,
            color: 0xffffff,
            metalness: 0.95,
            roughness: 0.24,
            envMapIntensity: 1.2,
        }),
    );
    knurl.position.set(0, baseTop + platterHeight - 0.075, 0.35);
    knurl.castShadow = true;
    group.add(knurl);

    for (const [radius, tube] of [
        [1.735, 0.008],
        [1.71, 0.005],
    ] as const) {
        const trim = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 6, 160), silver);
        trim.rotation.x = Math.PI / 2;
        trim.position.set(0, baseTop + platterHeight + 0.001, 0.35);
        group.add(trim);
    }

    /* 唱片 */
    const record = new THREE.Group();
    record.position.set(0, baseTop + platterHeight + 0.024, 0.35);

    const grooveTexture = makeGrooveTexture(renderer);
    const vinylMaterial = new THREE.MeshPhysicalMaterial({
        map: grooveTexture,
        color: 0xffffff,
        metalness: 0.12,
        roughness: 0.32,
        clearcoat: 1,
        clearcoatRoughness: 0.12,
        envMapIntensity: 0.9,
    });
    const vinylSideMaterial = new THREE.MeshStandardMaterial({
        color: COLOR.vinyl,
        metalness: 0.45,
        roughness: 0.34,
    });
    const vinyl = new THREE.Mesh(
        new THREE.CylinderGeometry(1.55, 1.55, 0.04, 128),
        [vinylSideMaterial, vinylMaterial, vinylSideMaterial],
    );
    vinyl.castShadow = true;
    vinyl.receiveShadow = true;
    record.add(vinyl);

    const labelTexture = makeLabelTexture(renderer);
    const label = new THREE.Mesh(
        new THREE.CircleGeometry(0.5, 64),
        new THREE.MeshStandardMaterial({
            map: labelTexture,
            metalness: 0.06,
            roughness: 0.5,
        }),
    );
    label.rotation.x = -Math.PI / 2;
    label.position.y = 0.021;
    record.add(label);

    /* 标签上的偏心贴纸：黑胶的同心纹旋转几乎看不出来，这颗亮点是「在转」的视觉锚 */
    const sticker = new THREE.Mesh(
        new THREE.CircleGeometry(0.085, 24),
        new THREE.MeshStandardMaterial({
            color: 0xffe1b0,
            emissive: 0x8a4a26,
            emissiveIntensity: 0.7,
            roughness: 0.55,
        }),
    );
    sticker.rotation.x = -Math.PI / 2;
    sticker.position.set(0.33, 0.026, 0.12);
    record.add(sticker);

    /* 外圈再放一颗更亮的标记：盘面与标签都偏暗时，边缘的移动更容易被眼睛捕捉 */
    const edgeMark = new THREE.Mesh(
        new THREE.SphereGeometry(0.055, 16, 10),
        new THREE.MeshStandardMaterial({
            color: 0xfff1cf,
            emissive: 0xa65a2a,
            emissiveIntensity: 0.8,
            roughness: 0.4,
        }),
    );
    edgeMark.position.set(1.24, 0.06, 0.35);
    record.add(edgeMark);

    const vinylEdge = new THREE.Mesh(
        new THREE.TorusGeometry(1.55, 0.012, 8, 160),
        new THREE.MeshStandardMaterial({
            color: COLOR.vinylEdge,
            metalness: 0.72,
            roughness: 0.26,
        }),
    );
    vinylEdge.rotation.x = Math.PI / 2;
    vinylEdge.position.y = 0.001;
    record.add(vinylEdge);

    group.add(record);

    /* 盘面高光：不随唱片旋转——它属于灯，而不是唱片 */
    const sheenTexture = makeGlowTexture(renderer);
    const sheenMaterial = new THREE.MeshBasicMaterial({
        map: sheenTexture,
        color: 0xffc28a,
        transparent: true,
        opacity: 0.34,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
    });
    const sheen = new THREE.Mesh(new THREE.CircleGeometry(1.53, 96), sheenMaterial);
    sheen.rotation.x = -Math.PI / 2;
    sheen.position.set(0, baseTop + platterHeight + 0.048, 0.35);
    group.add(sheen);

    /* 银色中轴 */
    const spindle = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.046, 0.19, 32), silver);
    spindle.position.set(0, baseTop + platterHeight + 0.128, 0.35);
    spindle.castShadow = true;
    group.add(spindle);
    const spindleCap = new THREE.Mesh(new THREE.SphereGeometry(0.045, 24, 12), silver);
    spindleCap.scale.y = 0.55;
    spindleCap.position.set(0, baseTop + platterHeight + 0.224, 0.35);
    group.add(spindleCap);

    /* 唱臂：右后方立柱 → 两段臂管 → 唱头，压在唱片右半侧 */
    const armBase = new THREE.Vector3(1.58, baseTop, -0.92);
    const pivot = new THREE.Mesh(
        new THREE.CylinderGeometry(0.24, 0.27, 0.09, 40),
        darkSilver,
    );
    pivot.position.set(armBase.x, baseTop + 0.045, armBase.z);
    pivot.castShadow = true;
    group.add(pivot);

    const pivotColumn = new THREE.Mesh(new THREE.CylinderGeometry(0.068, 0.075, 0.3, 24), silver);
    pivotColumn.position.set(armBase.x, baseTop + 0.22, armBase.z);
    pivotColumn.castShadow = true;
    group.add(pivotColumn);

    const pivotTop = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.16, 0.07, 32), darkSilver);
    pivotTop.position.set(armBase.x, baseTop + 0.405, armBase.z);
    pivotTop.castShadow = true;
    group.add(pivotTop);

    const armStart = new THREE.Vector3(armBase.x, baseTop + 0.45, armBase.z);
    const armMid = new THREE.Vector3(1.16, baseTop + 0.41, -0.12);
    const armHead = new THREE.Vector3(0.66, baseTop + 0.35, 0.58);
    const armMaterial = new THREE.MeshStandardMaterial({
        color: 0x8a8175,
        metalness: 1,
        roughness: 0.2,
        envMapIntensity: 1.2,
    });
    const armOne = cylinderBetween(armStart, armMid, 0.03, 0.026, armMaterial, 20);
    const armTwo = cylinderBetween(armMid, armHead, 0.026, 0.022, armMaterial, 20);
    armOne.castShadow = true;
    armTwo.castShadow = true;
    group.add(armOne, armTwo);

    const joint = new THREE.Mesh(new THREE.SphereGeometry(0.045, 20, 12), armMaterial);
    joint.position.copy(armMid);
    group.add(joint);

    /* 配重 */
    const counterweight = cylinderBetween(
        new THREE.Vector3(armBase.x + 0.02, baseTop + 0.45, armBase.z - 0.03),
        new THREE.Vector3(armBase.x + 0.32, baseTop + 0.45, armBase.z - 0.36),
        0.105,
        0.115,
        new THREE.MeshStandardMaterial({
            color: 0x1b1917,
            metalness: 0.6,
            roughness: 0.42,
        }),
        24,
    );
    counterweight.castShadow = true;
    group.add(counterweight);

    const counterweightCap = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.03, 24), silver);
    counterweightCap.position.set(armBase.x + 0.33, baseTop + 0.45, armBase.z - 0.37);
    counterweightCap.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0.3, 0, -0.33).normalize(),
    );
    group.add(counterweightCap);

    /* 唱头：小盒 + 卡座 + 针尖 */
    const headShell = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, 0.05, 0.17),
        new THREE.MeshStandardMaterial({
            color: 0x161413,
            metalness: 0.68,
            roughness: 0.32,
        }),
    );
    headShell.position.copy(armHead);
    headShell.rotation.y = Math.atan2(armHead.x - armMid.x, armHead.z - armMid.z);
    headShell.castShadow = true;
    group.add(headShell);

    const cartridge = new THREE.Mesh(
        new THREE.BoxGeometry(0.15, 0.07, 0.12),
        new THREE.MeshStandardMaterial({
            color: 0x6d2419,
            metalness: 0.2,
            roughness: 0.52,
        }),
    );
    cartridge.position.copy(armHead).add(new THREE.Vector3(0, -0.055, 0.015));
    cartridge.rotation.y = headShell.rotation.y;
    cartridge.castShadow = true;
    group.add(cartridge);

    const stylusTop = armHead.clone().add(new THREE.Vector3(0, -0.09, 0.035));
    const stylusBottom = new THREE.Vector3(0.64, baseTop + platterHeight + 0.05, 0.64);
    const stylus = cylinderBetween(stylusTop, stylusBottom, 0.008, 0.003, silver, 8);
    group.add(stylus);

    /* 前左侧的启动键与旋钮 */
    const startButton = new THREE.Mesh(
        new THREE.CylinderGeometry(0.085, 0.09, 0.025, 28),
        darkSilver,
    );
    startButton.position.set(-1.72, baseTop + 0.014, 1.33);
    group.add(startButton);

    const led = new THREE.Mesh(
        new THREE.SphereGeometry(0.026, 16, 10),
        new THREE.MeshStandardMaterial({
            color: 0xff8a4a,
            emissive: 0xff5a1e,
            emissiveIntensity: 2.4,
            roughness: 0.35,
        }),
    );
    led.scale.y = 0.45;
    led.position.set(-1.52, baseTop + 0.02, 1.33);
    group.add(led);

    for (const x of [-1.28, -0.98]) {
        const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.075, 0.035, 24), silver);
        knob.position.set(x, baseTop + 0.018, 1.33);
        knob.castShadow = true;
        group.add(knob);
    }

    return {group, record};
}

/** 后景直立的专辑封套（前后两面共用同一张程序化封面）。 */
function buildAlbum(renderer: THREE.WebGLRenderer): THREE.Group {
    const group = new THREE.Group();
    const coverTexture = makeCoverTexture(renderer);
    const coverMaterial = new THREE.MeshStandardMaterial({
        map: coverTexture,
        roughness: 0.82,
        metalness: 0.02,
        envMapIntensity: 0.35,
    });
    const sideMaterial = new THREE.MeshStandardMaterial({
        color: 0x24140f,
        roughness: 0.9,
        metalness: 0.02,
    });
    const box = new THREE.Mesh(new THREE.BoxGeometry(3.0, 3.0, 0.09), [
        sideMaterial,
        sideMaterial,
        sideMaterial,
        sideMaterial,
        coverMaterial,
        coverMaterial,
    ]);
    box.position.y = 1.5;
    box.castShadow = true;
    box.receiveShadow = true;
    group.add(box);
    group.position.set(1.85, 0, -2.55);
    group.rotation.y = -0.16;
    return group;
}

export function DiscoverDemo({className, backgroundUrl}: DiscoverDemoProps) {
    const {t} = useTranslation();
    const stageRef = useRef<HTMLDivElement | null>(null);
    const titleId = useId();
    const hintId = useId();
    const playing = useSelect((s) => s.player.playing);
    const detail = useSelect((s) => s.player.detail);
    const current = useSelect((s) => s.player.current);
    const background = useSelect((s) => s.ui.background);
    /* 用户自定义过背景（图片/视频/网页）时，让全局背景直接透进 demo；
       只有用默认主题时，才用当前曲目封面做 demo 的背板。 */
    const customBackground = Boolean(background.asset) || background.kind === 'web';
    const customBackgroundRef = useRef(customBackground);
    customBackgroundRef.current = customBackground;
    /* 播放态用 ref 传进 effect：切歌/暂停不应该重建整个 WebGL 场景 */
    const playingRef = useRef(playing);
    playingRef.current = playing;
    const artwork = backgroundUrl ?? detail?.artwork ?? current?.artwork ?? '';

    useEffect(() => {
        const stage = stageRef.current;
        if (!stage) return;

        /* 每次 effect 用一个**全新的 canvas**（R145 修复）：
           StrictMode 会执行一遍 setup → cleanup → setup；复用同一个 canvas 时，
           第一遍 cleanup 的 forceContextLoss() 会让第二遍拿到已丢失的 context，
           WebGLRenderer 在 getShaderPrecisionFormat 处读到 null 而报
           「Cannot read properties of null (reading 'precision')」，
           最终整块 3D 变成不可用。新建 canvas 后两遍互不影响。 */
        const canvas = document.createElement('canvas');
        canvas.className = styles.canvas;
        canvas.setAttribute('aria-hidden', 'true');
        stage.insertBefore(canvas, stage.firstChild);

        let renderer: THREE.WebGLRenderer;
        try {
            renderer = new THREE.WebGLRenderer({
                canvas,
                alpha: true,
                antialias: true,
                powerPreference: 'high-performance',
            });
        } catch (error) {
            /* WebGL 不可用（老机器 / 被策略禁用 / StrictMode 二次挂载拿到已销毁的 context）
               时保留文案与 CSS 氛围，不抛错，但留日志便于排查。 */
            console.warn('[discover-demo] WebGL unavailable', error);
            stage.dataset.webgl = 'unavailable';
            stage.dataset.webglError = error instanceof Error ? error.message : String(error);
            canvas.remove();
            return;
        }

        stage.dataset.webgl = 'ready';
        renderer.setPixelRatio(1);
        renderer.setClearColor(0x000000, 0);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.15;
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;

        const scene = new THREE.Scene();
        scene.fog = new THREE.FogExp2(0x120b08, 0.026);

        const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 80);

        /* 环境反射：程序化等距柱状图 → PMREM */
        const environmentSource = makeEnvironmentTexture(renderer);
        const pmrem = new THREE.PMREMGenerator(renderer);
        const environmentTarget = pmrem.fromEquirectangular(environmentSource);
        scene.environment = environmentTarget.texture;
        scene.environmentIntensity = 0.62;
        environmentSource.dispose();
        pmrem.dispose();

        /* ---------------- 桌面：镜面反射 + 木纹半透明叠加 + 软阴影 ---------------- */

        const reflector = new Reflector(new THREE.PlaneGeometry(32, 32), {
            clipBias: 0.003,
            textureWidth: 1024,
            textureHeight: 1024,
            color: COLOR.tableTint,
            multisample: 4,
        });
        reflector.rotation.x = -Math.PI / 2;
        reflector.position.y = 0;
        scene.add(reflector);

        const woodTexture = makeWoodTexture(renderer);
        const wood = new THREE.Mesh(
            new THREE.PlaneGeometry(28, 28),
            new THREE.MeshStandardMaterial({
                map: woodTexture,
                color: 0xffffff,
                roughness: 0.58,
                metalness: 0.04,
                transparent: true,
                opacity: 0.4,
                depthWrite: false,
            }),
        );
        wood.rotation.x = -Math.PI / 2;
        wood.position.y = 0.003;
        wood.renderOrder = 1;
        scene.add(wood);

        const shadowPlane = new THREE.Mesh(
            new THREE.PlaneGeometry(28, 28),
            new THREE.ShadowMaterial({color: 0x000000, opacity: 0.42}),
        );
        shadowPlane.rotation.x = -Math.PI / 2;
        shadowPlane.position.y = 0.006;
        shadowPlane.receiveShadow = true;
        shadowPlane.renderOrder = 2;
        scene.add(shadowPlane);

        const contactTexture = makeContactTexture(renderer);
        const addContactShadow = (x: number, z: number, sx: number, sz: number, opacity: number) => {
            const contact = new THREE.Mesh(
                new THREE.PlaneGeometry(1, 1),
                new THREE.MeshBasicMaterial({
                    map: contactTexture,
                    transparent: true,
                    opacity,
                    depthWrite: false,
                    toneMapped: false,
                }),
            );
            contact.rotation.x = -Math.PI / 2;
            contact.position.set(x, 0.008, z);
            contact.scale.set(sx, sz, 1);
            contact.renderOrder = 3;
            scene.add(contact);
        };
        addContactShadow(-0.6, 0.3, 6.3, 4.1, 0.6);
        addContactShadow(1.85, -2.5, 3.6, 1.2, 0.45);

        /* 后墙：让轮廓光和阴影有落点 */
        const wall = new THREE.Mesh(
            new THREE.PlaneGeometry(30, 12),
            new THREE.MeshStandardMaterial({
                color: COLOR.wall,
                roughness: 0.95,
                metalness: 0,
            }),
        );
        wall.position.set(0, 5.5, -4.4);
        wall.receiveShadow = true;
        /* 自定义背景时不要这面不透明墙，否则会把用户的视频/图片完全盖住 */
        wall.visible = !customBackgroundRef.current;
        scene.add(wall);

        /* ---------------- 主体 ---------------- */

        const hero = new THREE.Group();
        const turntable = buildTurntable(renderer);
        const album = buildAlbum(renderer);
        /* 唱机靠左前、封套靠右后：在 16:9 的卡里拉开横向关系，避免主体缩成一条竖线 */
        turntable.group.position.x = -0.55;
        hero.add(turntable.group, album);
        scene.add(hero);

        /* ---------------- 灯光 ---------------- */

        scene.add(new THREE.HemisphereLight(0xffc59a, 0x140b07, 0.52));
        scene.add(new THREE.AmbientLight(0x34170e, 0.42));

        const key = new THREE.SpotLight(COLOR.keyLight, 300, 30, 0.5, 0.88, 1.65);
        key.position.set(-5.2, 6.8, 4.9);
        key.target.position.set(0.25, 0.75, 0.1);
        key.castShadow = true;
        key.shadow.mapSize.set(1024, 1024);
        key.shadow.camera.near = 1;
        key.shadow.camera.far = 30;
        key.shadow.bias = -0.0006;
        key.shadow.normalBias = 0.02;
        key.shadow.radius = 3;
        scene.add(key, key.target);

        const rim = new THREE.PointLight(COLOR.rimLight, 18, 9, 2);
        rim.position.set(3.3, 2.2, -3.5);
        scene.add(rim);

        /* 冷色只做极轻的边缘分离，主调仍是暖色 */
        const edge = new THREE.DirectionalLight(COLOR.edgeLight, 0.32);
        edge.position.set(-4, 3, -3.5);
        scene.add(edge);

        /* 后景暖光晕：也让封套边缘从墙面上“浮”出来 */
        const glowTexture = makeGlowTexture(renderer);
        const glow = new THREE.Sprite(
            new THREE.SpriteMaterial({
                map: glowTexture,
                color: COLOR.glow,
                transparent: true,
                opacity: 0.32,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
                toneMapped: false,
            }),
        );
        glow.position.set(1.95, 2.4, -3.95);
        glow.scale.set(7.4, 7.4, 1);
        scene.add(glow);

        const backGlow = new THREE.Sprite(
            new THREE.SpriteMaterial({
                map: glowTexture,
                color: 0xff5a2e,
                transparent: true,
                opacity: 0.13,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
                toneMapped: false,
            }),
        );
        backGlow.position.set(-3.2, 2.1, -3.8);
        backGlow.scale.set(6.4, 6.4, 1);
        scene.add(backGlow);

        /* 灰尘：极少量、很淡，只负责空气感 */
        const dustTexture = makeGlowTexture(renderer, true);
        const dustRandom = seededRandom(11);
        const dustPositions: number[] = [];
        for (let i = 0; i < 120; i += 1) {
            dustPositions.push(
                (dustRandom() - 0.5) * 8,
                0.5 + dustRandom() * 3.6,
                (dustRandom() - 0.5) * 7,
            );
        }
        const dustGeometry = new THREE.BufferGeometry();
        dustGeometry.setAttribute('position', new THREE.Float32BufferAttribute(dustPositions, 3));
        const dust = new THREE.Points(
            dustGeometry,
            new THREE.PointsMaterial({
                map: dustTexture,
                color: COLOR.dust,
                size: 0.028,
                transparent: true,
                opacity: 0.55,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
                sizeAttenuation: true,
                toneMapped: false,
            }),
        );
        scene.add(dust);

        /* ---------------- 交互状态 ---------------- */

        const baseTheta = -0.45;
        /* R145：参考照片是「坐在唱机前、镜头略高于唱片」的低机位；
           1.1 太俯（能看到整块转盘顶面），1.48 几乎与唱片平视，封套更直立、唱片更前景。 */
        const basePhi = 1.48;        const yawLimit = 0.3;
        const pitchMin = -0.08;
        const pitchMax = 0.13;
        let targetYaw = 0;
        let targetPitch = 0;
        let yaw = 0;
        let pitch = 0;
        let hoverX = 0;
        let hoverY = 0;
        let pointerX = 0;
        let pointerY = 0;
        let dragging = false;
        let lastPointerX = 0;
        let lastPointerY = 0;

        const focusBox = new THREE.Box3().setFromObject(hero);
        const focusSphere = focusBox.getBoundingSphere(new THREE.Sphere());
        const focusCenter = focusSphere.center.clone();
        const lookTarget = focusCenter.clone();
        const corners: THREE.Vector3[] = [];
        for (const x of [focusBox.min.x, focusBox.max.x]) {
            for (const y of [focusBox.min.y, focusBox.max.y]) {
                for (const z of [focusBox.min.z, focusBox.max.z]) {
                    corners.push(new THREE.Vector3(x, y, z));
                }
            }
        }

        const worldUp = new THREE.Vector3(0, 1, 0);
        const offsetDirection = new THREE.Vector3();
        const forward = new THREE.Vector3();
        const right = new THREE.Vector3();
        const up = new THREE.Vector3();
        const relative = new THREE.Vector3();
        let focusDistance = 8;

        const fitCameraDistance = (theta: number, phi: number): number => {
            offsetDirection.setFromSphericalCoords(1, phi, theta);
            forward.copy(offsetDirection).negate();
            right.crossVectors(forward, worldUp).normalize();
            up.crossVectors(right, forward).normalize();
            const tanVertical = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * 0.9;
            const tanHorizontal = tanVertical * camera.aspect;
            let distance = 0;
            for (const corner of corners) {
                relative.copy(corner).sub(lookTarget);
                const x = relative.dot(right);
                const y = relative.dot(up);
                const z = relative.dot(forward);
                distance = Math.max(
                    distance,
                    Math.abs(x) / tanHorizontal - z,
                    Math.abs(y) / tanVertical - z,
                );
            }
            return Math.max(3.2, distance + 0.06);
        };

        const resize = () => {
            const rect = stage.getBoundingClientRect();
            const width = Math.max(1, Math.round(rect.width));
            const height = Math.max(1, Math.round(rect.height));
            if (width < 2 || height < 2) return;

            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            renderer.setPixelRatio(dpr);
            renderer.setSize(width, height, false);

            camera.aspect = width / height;
            camera.updateProjectionMatrix();

            /* 竖屏时把取景中心稍微抬高，给顶部文案留出空间 */
            lookTarget.copy(focusCenter);
            /* 低机位时视线略微下压到唱片上沿，不要盯着封套中心（否则又会俯视）。 */
            lookTarget.y += width < 720 ? 0.24 : 0.02;

            const reflectionSize = width < 720 ? 640 : 1024;
            const reflectionHeight = Math.max(
                256,
                Math.round(reflectionSize * (height / width)),
            );
            reflector.getRenderTarget().setSize(reflectionSize, reflectionHeight);

            focusDistance = fitCameraDistance(
                baseTheta + yaw + hoverX * 0.022,
                basePhi + pitch + hoverY * 0.014,
            );
        };

        const resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(stage);
        window.addEventListener('resize', resize);
        resize();

        /* 系统减少动态效果：停止唱片自转 */
        const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
        let reduceMotion = motionQuery.matches;
        const onMotionChange = () => {
            reduceMotion = motionQuery.matches;
        };
        motionQuery.addEventListener('change', onMotionChange);

        const endDrag = (event: PointerEvent) => {
            if (!dragging) return;
            dragging = false;
            stage.dataset.dragging = 'false';
            if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
        };

        const onPointerDown = (event: PointerEvent) => {
            if (event.pointerType === 'mouse' && event.button !== 0) return;
            dragging = true;
            lastPointerX = event.clientX;
            lastPointerY = event.clientY;
            stage.dataset.dragging = 'true';
            stage.setPointerCapture(event.pointerId);
        };

        const onPointerMove = (event: PointerEvent) => {
            const rect = stage.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                pointerX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
                pointerY = ((event.clientY - rect.top) / rect.height) * 2 - 1;
            }

            if (!dragging) return;
            const dx = event.clientX - lastPointerX;
            const dy = event.clientY - lastPointerY;
            lastPointerX = event.clientX;
            lastPointerY = event.clientY;

            const yawScale = 0.9 / Math.max(300, rect.width);
            const pitchScale = 0.5 / Math.max(240, rect.height);
            targetYaw = THREE.MathUtils.clamp(targetYaw + dx * yawScale, -yawLimit, yawLimit);
            targetPitch = THREE.MathUtils.clamp(
                targetPitch + dy * pitchScale,
                pitchMin,
                pitchMax,
            );
        };

        const onPointerLeave = () => {
            if (dragging) return;
            pointerX = 0;
            pointerY = 0;
        };

        stage.addEventListener('pointerdown', onPointerDown);
        stage.addEventListener('pointermove', onPointerMove);
        stage.addEventListener('pointerup', endDrag);
        stage.addEventListener('pointercancel', endDrag);
        stage.addEventListener('lostpointercapture', endDrag);
        stage.addEventListener('pointerleave', onPointerLeave);

        /* ---------------- 渲染循环 ---------------- */

        const clock = new THREE.Clock();
        let disposed = false;

        renderer.setAnimationLoop(() => {
            if (disposed) return;
            const delta = Math.min(clock.getDelta(), 0.05);

            /* 阻尼：拖拽是有惯性的，但幅度很小 */
            const easing = 1 - Math.exp(-delta * 7);
            yaw += (targetYaw - yaw) * easing;
            pitch += (targetPitch - pitch) * easing;
            hoverX += (pointerX - hoverX) * (1 - Math.exp(-delta * 4));
            hoverY += (pointerY - hoverY) * (1 - Math.exp(-delta * 4));

            if (!reduceMotion && playingRef.current) {
                /* 唱盘严格跟随播放态：暂停/未播放时停在当前角度（预备接口，
                   后续接主播放器时不需要再改场景）。速度比旧版更快，标签与
                   贴纸的偏心才看得出来。 */
                turntable.record.rotation.y = (turntable.record.rotation.y - delta * 1.05) % (Math.PI * 2);
                dust.rotation.y += delta * 0.008;
            }

            const cameraYaw = baseTheta + yaw + hoverX * 0.022;
            const cameraPitch = basePhi + pitch + hoverY * 0.014;
            focusDistance = fitCameraDistance(cameraYaw, cameraPitch);
            offsetDirection.setFromSphericalCoords(1, cameraPitch, cameraYaw);
            camera.position.copy(lookTarget).addScaledVector(offsetDirection, focusDistance);
            camera.lookAt(lookTarget);
            camera.updateMatrixWorld();

            renderer.render(scene, camera);
        });

        return () => {
            disposed = true;
            renderer.setAnimationLoop(null);
            resizeObserver.disconnect();
            window.removeEventListener('resize', resize);
            motionQuery.removeEventListener('change', onMotionChange);
            stage.removeEventListener('pointerdown', onPointerDown);
            stage.removeEventListener('pointermove', onPointerMove);
            stage.removeEventListener('pointerup', endDrag);
            stage.removeEventListener('pointercancel', endDrag);
            stage.removeEventListener('lostpointercapture', endDrag);
            stage.removeEventListener('pointerleave', onPointerLeave);

            /* 释放 GPU 资源：geometry / material / 材质里的所有 texture */
            const geometries = new Set<THREE.BufferGeometry>();
            const materials = new Set<THREE.Material>();
            scene.traverse((object) => {
                const mesh = object as THREE.Mesh;
                if (mesh.geometry) geometries.add(mesh.geometry);
                if (mesh.material) {
                    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                    for (const material of list) materials.add(material);
                }
                const light = object as THREE.Light;
                if (light.isLight && light.shadow?.map) light.shadow.map.dispose();
            });

            for (const geometry of geometries) geometry.dispose();
            for (const material of materials) {
                for (const value of Object.values(material)) {
                    const maybeTexture = value as THREE.Texture | null;
                    if (maybeTexture && maybeTexture.isTexture) maybeTexture.dispose();
                }
                material.dispose();
            }

            reflector.dispose();
            environmentTarget.dispose();
            scene.environment = null;
            scene.clear();

            renderer.dispose();
            renderer.forceContextLoss();
            canvas.remove();
            delete stage.dataset.webgl;
            delete stage.dataset.webglError;
            delete stage.dataset.dragging;
        };
    }, []);

    return (
        <section
            className={`${styles.root}${className ? ` ${className}` : ''}`}
            aria-labelledby={titleId}
            data-discover-demo=""
            data-custom-background={customBackground}
        >
            <div
                ref={stageRef}
                className={styles.stage}
                data-dragging="false"
                data-playing={playing}
                data-custom-background={customBackground}
                role="group"
                aria-describedby={hintId}
            >
                {artwork && !customBackground && (
                    <div
                        className={styles.artworkBackdrop}
                        style={{backgroundImage: `url("${artwork}")`}}
                        aria-hidden="true"
                    />
                )}
                <div className={styles.veil} aria-hidden="true"/>
                <div className={styles.glow} aria-hidden="true"/>

                <header className={styles.copy}>
                    <h2 id={titleId} className={styles.title}>
                        {t('page.discoverDemo.title')}
                    </h2>
                    <p className={styles.subtitle}>{t('page.discoverDemo.subtitle')}</p>
                </header>

                <footer className={styles.footer}>
                    <p id={hintId} className={styles.hint}>
                        <span className={styles.hintDot} aria-hidden="true"/>
                        <span>{t('page.discoverDemo.hint')}</span>
                    </p>
                    <span className={styles.dragTag}>
                        <span className={styles.dragGlyph} aria-hidden="true">↔</span>
                        {t('page.discoverDemo.drag')}
                    </span>
                </footer>
            </div>
        </section>
    );
}

export default DiscoverDemo;
