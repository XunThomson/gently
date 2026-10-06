/**
 * 冒烟测试：不依赖浏览器，验证「状态层逻辑」与「各组件可渲染」。
 *
 * 运行方式见 AGENTS.md：esbuild 打包到临时目录后由 node 执行。
 * 退出码非 0 表示有断言或渲染失败。
 */
import {renderToString} from 'react-dom/server';
import {MemoryRouter} from 'react-router';
import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import type {ReactNode} from 'react';

import '../src/i18n';
import {ThemeProvider} from '../src/theme';
import {resolveTheme, themePresets} from '../src/theme';
import {store, useActions} from '../src/store';
import {buildCssVars, themeConfig} from '../src/theme/tokens';
import {getActiveMusicSource, listMusicSources} from '../src/plugins';
import {catalogService, fileService, libraryService} from '../src/services';
import zh from '../src/i18n/locales/zh.json';
import en from '../src/i18n/locales/en.json';

import {TitleBar} from '../src/components/shell/title-bar';
import {Sidebar} from '../src/components/shell/sidebar';
import {PlayerBar} from '../src/components/shell/player-bar';
import {buildMenuRoutes, appRoutes} from '../src/router/meta';

import RankingView from '../src/views/ranking';
import HotView from '../src/views/hot';
import DownloadView from '../src/views/download';
import DownloadingView from '../src/views/download/downloading';
import DownloadedView from '../src/views/download/downloaded';
import LocalView from '../src/views/local';
import PluginView from '../src/views/plugin';
import RecentView from '../src/views/recent';
import SettingView from '../src/views/setting';
import ThemeView from '../src/views/theme';
import FavoritesView from '../src/views/favorites';
import PlaylistView from '../src/views/playlist';
import NowPlayingView from '../src/views/now-playing';

const failures: string[] = [];
const notes: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
    if (condition) {
        notes.push(`  ok   ${name}`);
    } else {
        failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
        notes.push(`  FAIL ${name}`);
    }
}

function render(name: string, node: ReactNode): void {
    try {
        const html = renderToString(
            <MemoryRouter>
                <ThemeProvider>{node}</ThemeProvider>
            </MemoryRouter>,
        );
        check(`render ${name}`, html.length > 0, 'empty html');
    } catch (err) {
        failures.push(`render ${name} — ${(err as Error).message}`);
        notes.push(`  FAIL render ${name}`);
    }
}

/* ---------------- i18n 死键检查 ---------------- */

/** 这些前缀下的键由模板字符串拼接而成，无法按字面量检索 */
const DYNAMIC_PREFIXES = [
    'page.ranking.chart.',
    'page.ranking.period.',
    'page.download.status.',
    'page.setting.theme',
    'language.',
];

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
    return Object.entries(obj).flatMap(([key, value]) => {
        const full = prefix ? `${prefix}.${key}` : key;
        return value && typeof value === 'object'
            ? flattenKeys(value as Record<string, unknown>, full)
            : [full];
    });
}

/** 读取 src 下所有源码文本，用于检索 i18n key 是否被引用 */
function readSourceText(dir = 'src', acc: string[] = []): string {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) readSourceText(full, acc);
        else if (/\.(tsx?|json)$/.test(entry.name)) acc.push(readFileSync(full, 'utf8'));
    }
    return acc.join('\n');
}

function checkI18n(): void {
    const source = readSourceText();
    const zhKeys = flattenKeys(zh as Record<string, unknown>);
    const enKeys = flattenKeys(en as Record<string, unknown>);

    const missing = zhKeys.filter((key) => !enKeys.includes(key));
    check('i18n: zh/en 键集合一致', missing.length === 0, `en 缺少 ${missing.join(', ')}`);

    const dead = zhKeys.filter(
        (key) =>
            !DYNAMIC_PREFIXES.some((prefix) => key.startsWith(prefix)) &&
            !source.includes(`'${key}'`) &&
            !source.includes(`"${key}"`),
    );
    check('i18n: 无未被引用的死键', dead.length === 0, `死键 ${dead.join(', ')}`);
}

async function main(): Promise<void> {
    /* ---------------- i18n ---------------- */
    checkI18n();

    /* ---------------- 主题 ---------------- */
    const light = buildCssVars(themeConfig, 'light');    const dark = buildCssVars(themeConfig, 'dark');

    check('theme: light/dark 变量数量一致', Object.keys(light).length === Object.keys(dark).length);
    check('theme: 浅色应用底色较亮', light['--bg-app'] !== dark['--bg-app']);
    check('theme: 未解析的语义引用已全部展开', !Object.values(light).some((v) => v.startsWith('{')), 'still has {ref}');
    check('theme: 搜索框高度由配置驱动', light['--search-box-height'] === `${themeConfig.components.searchBox.height}px`);
    check('theme: 间距 token 已生成', light['--space-4'] === '16px');

    /* ---------------- 主题市场预设 ---------------- */
    check('theme: 主题市场至少提供 2 套预设', themePresets.length >= 2);
    check('theme: 每套预设都有预览色块', themePresets.every((p) => p.swatches.length >= 3));

    const ocean = resolveTheme(themeConfig, 'ocean');
    check('theme: 预设覆盖品牌色', ocean.palette.brand !== themeConfig.palette.brand);
    check('theme: 预设可覆盖配色板', ocean.scheme.light.app !== themeConfig.scheme.light.app);
    check(
        'theme: 未声明的字段继承主题配置',
        ocean.components.dataTable.cellPaddingY === themeConfig.components.dataTable.cellPaddingY,
    );
    check('theme: 未知预设回落默认主题', resolveTheme(themeConfig, 'nope').palette.brand === themeConfig.palette.brand);

    const presetVars = buildCssVars(ocean, 'light');
    check('theme: 预设会改变注入的 --brand', presetVars['--brand'] === ocean.palette.brand);

    /* ---------------- 插件（数据源） ---------------- */
    const sources = listMusicSources();
    check('plugins: 内置源已注册', sources.length > 0);
    check('plugins: 当前源可用', !!getActiveMusicSource().info.id);

    const chart = await catalogService.fetchChart({chart: 'hot', period: 'day', date: {year: 2025, month: 1, day: 1}, dateKey: 'day-2025-01-01'});
    check('plugins: fetchChart 返回榜单行', chart.length > 0);
    check('plugins: 榜单缓存命中', (await catalogService.fetchChart({chart: 'hot', period: 'day', date: {year: 2025, month: 1, day: 1}, dateKey: 'day-2025-01-01'})) === chart);

    const found = await catalogService.search('晚风');
    check('plugins: search 命中曲目', found.length > 0 && found[0].title.includes('晚风'));
    check('plugins: 空关键词返回空', (await catalogService.search('   ')).length === 0);

    /* ---------------- 本地数据门面 ---------------- */
    const local = await libraryService.loadLocal();
    const downloads = await libraryService.loadDownloads();
    const plugins = await libraryService.loadPlugins();
    check('services: 本地曲库非空', local.length > 0);
    check('services: 下载任务非空', downloads.length > 0);
    check('services: 插件列表非空', plugins.some((p) => p.builtin));

    /* 浏览器（非 Tauri）环境下文件操作必须是安全的空操作 */
    let fileOk = true;
    try {
        await fileService.revealInDir('D:/Music/demo.flac');
    } catch {
        fileOk = false;
    }
    check('services: 非 Tauri 环境下文件操作为空操作', fileOk);

    /* ---------------- 状态层 ---------------- */
    const actions = useActions();
    const s = () => store.getState();

    check('store: 初始未在播放', s().player.current === null && !s().player.playing);

    await actions.library.load();
    check('store: library.load 写入数据', s().library.loaded && s().library.local.length > 0);
    check('store: 重复 load 幂等', s().library.local.length === local.length);

    const first = s().library.local[0];
    actions.player.play(first, s().library.local);
    check('store: play 设置当前曲目', s().player.current?.id === first.id && s().player.playing);
    check('store: play 记录播放时长', s().player.duration === first.durationSec);
    check('store: play 写入最近播放', s().library.recent.some((r) => r.id === first.id));

    actions.library.clearRecent();
    check('store: 清空最近播放', s().library.recent.length === 0);
    actions.player.play(first, s().library.local);

    actions.player.tick();
    check('store: tick 推进进度', s().player.elapsed === 1);

    actions.player.next();
    check('store: next 切到队首（顺序播放且 index=0 越界时停止）', s().player.playing === false || s().player.current?.id !== first.id);

    const queue = s().library.local.slice(0, 3);
    actions.player.play(queue[0], queue);
    actions.player.next();
    check('store: next 前进到下一首', s().player.current?.id === queue[1].id);
    actions.player.prev();
    check('store: prev 回到开头', s().player.elapsed === 0);

    actions.player.setRepeat('one');
    const before = s().player.current?.id;
    actions.player.next();
    check('store: 单曲循环保持同一首', s().player.current?.id === before);
    actions.player.setRepeat('off');

    actions.player.setVolume(2);
    check('store: 音量上限钳制', s().player.volume === 1);

    actions.player.toggle();
    check('store: toggle 暂停', s().player.playing === false);

    /* 列表点击语义：当前曲目 = 播放/暂停，其他曲目 = 切歌 */
    actions.player.play(queue[0], queue);
    check('store: 播放队列首曲目', s().player.current?.id === queue[0].id && s().player.playing);
    actions.player.playOrToggle(queue[0], queue);
    check('store: 点当前曲目切换为暂停', !s().player.playing && s().player.current?.id === queue[0].id);
    actions.player.playOrToggle(queue[0], queue);
    check('store: 再点当前曲目恢复播放', s().player.playing);
    actions.player.playOrToggle(queue[2], queue);
    check('store: 点其他曲目切歌播放', s().player.current?.id === queue[2].id && s().player.playing);

    /* 歌词：随播放异步加载，切歌后不串词 */
    await new Promise((resolve) => setTimeout(resolve, 220));
    check('store: 播放后异步加载歌词', s().player.lyrics.length > 0);
    check(
        'store: 歌词时间轴严格递增',
        s().player.lyrics.every((line, i, all) => i === 0 || line.time > all[i - 1].time),
    );
    actions.player.stop();
    check('store: stop 清空歌词与进度', s().player.lyrics.length === 0 && s().player.elapsed === 0);

    /* UI 切片 */
    actions.ui.setThemeMode('dark');
    check('store: 主题模式写入', s().ui.themeMode === 'dark');
    actions.ui.setSearchQuery('测试');
    check('store: 搜索词写入', s().ui.searchQuery === '测试');
    actions.ui.toggleGroup('playlists');
    check('store: 分组折叠', s().ui.collapsedGroups.includes('playlists'));
    actions.ui.toggleGroup('playlists');
    check('store: 分组展开', !s().ui.collapsedGroups.includes('playlists'));

    /* 榜单切片 */
    await actions.ranking.setChart('rise');
    check('store: 榜单切换并加载', s().ranking.chart === 'rise' && s().ranking.rows.length > 0);
    actions.ranking.setQuery('晚风');
    check('store: 榜单关键词写入', s().ranking.query === '晚风');
    actions.ranking.setQuery('');
    actions.ranking.toggleExpanded();
    check('store: 展开状态切换', s().ranking.expanded === true);
    actions.ranking.toggleExpanded();

    /* 下载切片 */
    await actions.download.load();
    const downloading = s().download.tasks.find((task) => task.status === 'downloading');
    check('store: 下载任务已加载', !!downloading);
    if (downloading) {
        actions.download.pause(downloading.id);
        check('store: 暂停下载', s().download.tasks.find((t) => t.id === downloading.id)?.status === 'paused');
        actions.download.resume(downloading.id);
        check('store: 继续下载', s().download.tasks.find((t) => t.id === downloading.id)?.status === 'downloading');
    }
    const doneCount = s().download.tasks.filter((t) => t.status === 'done').length;
    actions.download.clearFinished();
    check('store: 清理已完成', s().download.tasks.every((t) => t.status !== 'done') && doneCount > 0);

    /* 从列表加入下载队列 */
    const dlTrack = s().library.local[3];
    const tasksBefore = s().download.tasks.length;
    actions.download.add(dlTrack);
    check('store: 加入下载队列', s().download.tasks.some((t) => t.track.id === dlTrack.id));
    actions.download.add(dlTrack);
    check('store: 重复加入下载队列不产生重复项', s().download.tasks.length === tasksBefore + 1);

    const addedTask = s().download.tasks.find((t) => t.track.id === dlTrack.id)!;
    check('store: 新下载任务状态为等待中', addedTask.status === 'pending');
    actions.download.resume(addedTask.id);
    check(
        'store: 等待中任务可直接开始',
        s().download.tasks.find((t) => t.id === addedTask.id)?.status === 'downloading',
    );
    actions.download.remove(addedTask.id);
    check('store: 可移除下载任务', !s().download.tasks.some((t) => t.id === addedTask.id));

    /* 下载引擎：进度推进 → 完成 */
    const runningTasks = s().download.tasks.filter((t) => t.status === 'downloading');
    check('store: 存在下载中的任务（引擎前置条件）', runningTasks.length > 0);

    const progressBefore = runningTasks[0].progress;
    const sizeBefore = runningTasks[0].sizeText;
    actions.download.tick();
    const ticked = s().download.tasks.find((t) => t.id === runningTasks[0].id)!;
    check(
        'store: 下载引擎推进进度并刷新大小文案',
        ticked.progress > progressBefore && ticked.sizeText !== sizeBefore,
    );

    for (let i = 0; i < 40; i += 1) actions.download.tick();
    check('store: 下载可推进到完成', s().download.tasks.every((t) => t.status !== 'downloading'));
    check(
        'store: 完成后进度为 1 且清空速度',
        s()
            .download.tasks.filter((t) => t.status === 'done')
            .every((t) => t.progress === 1 && !t.speedText),
    );

    /* 插件切片 */
    await actions.plugin.load();
    check('store: 插件列表已加载', s().plugin.list.length > 0);
    const target = s().plugin.list.find((p) => !p.builtin)!;
    actions.plugin.setEnabled(target.id, false);
    check('store: 禁用插件', s().plugin.list.find((p) => p.id === target.id)?.enabled === false);
    const version = target.version;
    actions.plugin.update(target.id);
    check('store: 更新插件版本', s().plugin.list.find((p) => p.id === target.id)?.version !== version);
    actions.plugin.remove(target.id);
    check('store: 内置插件不可卸载', s().plugin.list.some((p) => p.builtin));
    check('store: 第三方插件可卸载', !s().plugin.list.some((p) => p.id === target.id));

    /* 收藏 / 歌单 */
    await actions.collection.load();
    check(
        'collection: 初始收藏与歌单已加载',
        s().collection.loaded && s().collection.favorites.length > 0 && s().collection.playlists.length > 0,
    );

    const favTrack = s().library.local[1];
    const favBefore = actions.collection.isFavorite(favTrack.id);
    actions.collection.toggleFavorite(favTrack);
    check('collection: 收藏状态可切换', actions.collection.isFavorite(favTrack.id) !== favBefore);
    actions.collection.toggleFavorite(favTrack);
    check('collection: 可恢复原收藏状态', actions.collection.isFavorite(favTrack.id) === favBefore);

    const created = actions.collection.createPlaylist('  单测歌单  ');
    check(
        'collection: 新建歌单并去除首尾空格',
        s().collection.playlists[0]?.id === created.id && created.name === '单测歌单' && created.tracks.length === 0,
    );
    check('collection: 新建歌单名称为空时回落默认名', actions.collection.createPlaylist('   ').name.length > 0);

    actions.collection.addToPlaylist(created.id, favTrack);
    check('collection: 加入歌单', s().collection.playlists.find((p) => p.id === created.id)?.tracks.length === 1);
    actions.collection.addToPlaylist(created.id, favTrack);
    check('collection: 重复加入不产生重复项', s().collection.playlists.find((p) => p.id === created.id)?.tracks.length === 1);
    actions.collection.removeFromPlaylist(created.id, favTrack.id);
    check('collection: 移出歌单', s().collection.playlists.find((p) => p.id === created.id)?.tracks.length === 0);

    actions.collection.renamePlaylist(created.id, '改名后');
    check('collection: 重命名歌单', s().collection.playlists.find((p) => p.id === created.id)?.name === '改名后');
    actions.collection.renamePlaylist(created.id, '   ');
    check('collection: 空名称不覆盖原名称', s().collection.playlists.find((p) => p.id === created.id)?.name === '改名后');

    actions.collection.removePlaylist(created.id);
    check('collection: 删除歌单', !s().collection.playlists.some((p) => p.id === created.id));

    /* 导航：设置只保留右上角入口 */
    const menuPaths = buildMenuRoutes(appRoutes).map((item) => item.path);
    check('nav: 侧边栏不再包含 /setting（避免与右上角重复）', !menuPaths.includes('/setting'));
    check('nav: 主题市场不在侧边栏主菜单', !menuPaths.includes('/theme'));
    check('nav: 主菜单为 6 项', menuPaths.length === 6);

    /* ---------------- 组件渲染 ---------------- */
    render('TitleBar', <TitleBar/>);
    render('Sidebar', <Sidebar mainMenu={buildMenuRoutes(appRoutes)}/>);
    render('PlayerBar', <PlayerBar/>);
    render('RankingView', <RankingView/>);
    render('HotView', <HotView/>);
    render('DownloadView', <DownloadView/>);
    render('DownloadingView', <DownloadingView/>);
    render('DownloadedView', <DownloadedView/>);
    render('LocalView', <LocalView/>);
    render('PluginView', <PluginView/>);
    render('RecentView', <RecentView/>);
    render('SettingView', <SettingView/>);
    render('ThemeView', <ThemeView/>);
    render('FavoritesView', <FavoritesView/>);
    render('PlaylistView', <PlaylistView/>);

    /* 歌曲详情：先恢复播放，确保歌词面板也有内容可渲染 */
    actions.player.play(s().library.local[2], s().library.local);
    await new Promise((resolve) => setTimeout(resolve, 220));
    render('NowPlayingView（含歌词）', <NowPlayingView/>);
    check('页面：歌曲详情渲染时歌词已就绪', s().player.lyrics.length > 0);

    /* 主题市场：切换预设写入 ui 切片，ThemeProvider 会据此重算 CSS 变量 */
    actions.ui.setThemePreset('sakura');
    check('store: 主题市场预设写入 ui 切片', s().ui.themePresetId === 'sakura');
    actions.ui.setThemePreset(themePresets[0].id);
    check('store: 预设可切回默认', s().ui.themePresetId === themePresets[0].id);

    console.log(notes.join('\n'));
    if (failures.length > 0) {
        console.error(`\n冒烟测试失败 ${failures.length} 项：`);
        failures.forEach((f) => console.error(` - ${f}`));
        process.exit(1);
    }
    console.log(`\n冒烟测试通过：${notes.length} 项全部成功。`);
}

main().catch((err) => {
    console.error('冒烟测试异常终止：', err);
    process.exit(1);
});
