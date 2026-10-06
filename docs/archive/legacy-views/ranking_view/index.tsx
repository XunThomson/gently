import Hero from "../../components/card/Hero";
import ChartSection from "../../components/section/ChartSection";

export default function RankingView() {
    return (
        <div className="ranking-view">
            <Hero onPlay={() => {
            }}></Hero>

            <ChartSection chart={} period={} date={} weekStart={} expanded={} query={} rows={} dateKey={} rangeText={}
                          current={} onChartChange={} onPeriodChange={} onDateChange={} onWeekChange={}
                          onToggleExpand={} onSelect={}>

            </ChartSection>


        </div>
    );
}