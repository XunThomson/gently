import {useTranslation} from "react-i18next";
import SearchBox from "../../components/input/SearchBox.tsx";
import {ColumnDef, DataTable} from "../../components/table/DataTable";


export default function LocalView() {
    const {t} = useTranslation();

    const viewNav = 'nav.local';

//     const hotWords = ['React Hooks', 'TypeScript', 'Vite', 'Tailwind CSS'];
//
// // 模拟异步联想接口
//     async function fetchSuggestions(kw: string): Promise<SearchSuggestion[]> {
//         await new Promise((r) => setTimeout(r, 300));
//         return [
//             {value: `${kw} 教程`, desc: '文章'},
//             {value: `${kw} 实战`, desc: '视频'},
//             {value: `${kw} 面试题`, desc: '题库'},
//         ];
//     }

    const musicColumns: ColumnDef<any>[] = [
        { key: 'index', title: '#', width: '50px', align: 'center' },
        {
            key: 'title',
            title: '标题',
            width: 'minmax(250px, 1.5fr)',
            render: (val, record) => <span style={{ color: record.isActive ? '#fff' : '#e0e0e0' }}>{val}</span>
        },
        { key: 'author', title: '作者', width: '1fr' },
        { key: 'album', title: '专辑', width: '1fr' },
        { key: 'duration', title: '时长', width: '80px', align: 'center' },
        {
            key: 'source',
            title: '来源',
            width: '100px',
            render: (val) => <span className="badge">{val}</span>
        },
    ];

    const musicData = [
        { id: 1, index: 1, title: '【探窗】开口跪！...', author: '共青团中央', album: 'BV1dL411M7Se', duration: '03:11', source: 'bilibili', isActive: true },
        { id: 2, index: 2, title: '【Hi-Res无损】《伯虎说》...', author: '心刚音乐库', album: 'BV1KYYTegE3K', duration: '03:39', source: 'bilibili' },
    ];

    return (
        <div className="local-view flex flex-col w-full">
            <div className={`view-nav font-bold text-2xl`}>
                {t(viewNav)}
            </div>
            <div className={`view-toolbar flex justify-between w-full p-4`}>
                <div className={"left-section"}></div>
                <div className={'right-section'}>
                    <div className={`search-box`}>
                        <SearchBox></SearchBox>
                        {/*<SearchBox*/}
                        {/*    placeholder="搜索文章 / 视频 / 题库"*/}
                        {/*    hotWords={hotWords}*/}
                        {/*    suggestions={fetchSuggestions}*/}
                        {/*    historyKey="demo:search-history"*/}
                        {/*    maxHistory={8}*/}
                        {/*    onSearch={(kw) => console.log('搜索:', kw)}*/}
                        {/*/>*/}
                    </div>
                    <div className={`radio-box`}></div>
                </div>
            </div>
            <div className={`view-content`}>
                <DataTable columns={musicColumns} dataSource={musicData} rowKey="id" />
            </div>
        </div>
    );
}