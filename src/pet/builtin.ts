/**
 * 内置宠物的**规格**（就是包里那份 `pet.json` 原文）。
 *
 * 只做数据转发：规格来源是仓库里的示例包 `pets/gently-mascot/pet.json`（与图集同目录），
 * 这样「内置宠物」和「用户导入的宠物包」是**同一套东西**——不会出现内置一套格式、
 * 导入另一套格式的两份真相。解析与校验仍然只在核心（前端不预解析）。
 *
 * 图集是一张 9 行 × 8 格的 sprite sheet（每格 192×208）。图集本身必须**带透明通道**：
 * 带白底/黑底的图会渲染成一个方块（作者常犯的错，见 docs/pet-package.md）。
 */
import spec from '../../pets/gently-mascot/pet.json';
import atlasUrl from '../../pets/gently-mascot/atlas.png';

/** 内置宠物的规格（`pet.json` 原文；解析与校验都在核心） */
export const BUILTIN_PET_SPEC: string = JSON.stringify(spec);

/** 内置宠物的 id（首次安装、以及「没有图集」时的程序化渲染都靠它） */
export const BUILTIN_PET_ID: string = spec.id;

/** 内置宠物的版本（图集/行为变了就升版本，渲染器据此自动重装） */
export const BUILTIN_PET_VERSION: string = spec.version;

/** 内置图集在包里的文件名（核心只收纯文件名） */
export const BUILTIN_PET_ATLAS_FILE = 'atlas.png';

/** 内置图集的打包后 URL（运行时 fetch → base64 → `pet.install`） */
export const BUILTIN_PET_ATLAS_URL: string = atlasUrl;


