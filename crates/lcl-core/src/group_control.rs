//! Pure per-wireless-group control, shared by the daemon and boot keeper.
use crate::config::{CoolingMode, Curve, MIN_FAN_PERCENT, GUARD_FAN_PERCENT};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum GroupSource { Coolant, Gpu, #[default] Cpu }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct FanGroupPolicy {
    pub address: String,
    pub mode: CoolingMode,
    pub fixed_percent: f32,
    pub source: GroupSource,
    pub curve: Curve,
    pub sample_interval_ms: u64,
    pub smoothing_ms: u64,
    pub hysteresis_c: f32,
    pub fall_delay_s: f32,
    pub slew_up_percent_per_s: f32,
    pub slew_down_percent_per_s: f32,
    pub fallback_percent: f32,
}
impl Default for FanGroupPolicy {
    fn default() -> Self { Self {
        address: String::new(), mode: CoolingMode::Curve, fixed_percent: 50.0,
        source: GroupSource::Cpu,
        curve: Curve { points: vec![[35.0,30.0],[50.0,45.0],[70.0,75.0],[85.0,100.0]] },
        sample_interval_ms: 1000, smoothing_ms: 0, hysteresis_c: 1.0,
        fall_delay_s: 3.0, slew_up_percent_per_s: 10.0, slew_down_percent_per_s: 5.0,
        fallback_percent: 80.0,
    } }
}
impl FanGroupPolicy {
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(crate::parse_mac(&self.address).is_some(), "无效风扇组地址");
        for n in [self.fixed_percent,self.hysteresis_c,self.fall_delay_s,self.slew_up_percent_per_s,self.slew_down_percent_per_s,self.fallback_percent] {
            anyhow::ensure!(n.is_finite(), "风扇策略含非有限数值");
        }
        anyhow::ensure!(!self.curve.points.is_empty() && self.curve.points.len() <= 32, "曲线需1–32个采样点");
        let mut xs=std::collections::BTreeSet::new();
        for [x,y] in &self.curve.points {
            anyhow::ensure!(x.is_finite() && y.is_finite() && (0.0..=130.0).contains(x), "无效曲线采样点");
            // Compare numeric temperatures, including -0 and +0.
            anyhow::ensure!(xs.insert(if *x == 0.0 {0} else {x.to_bits()}), "曲线温度点不能重复");
        }
        Ok(())
    }
    pub fn normalize(&mut self) {
        self.address=self.address.to_ascii_lowercase();
        self.fixed_percent=self.fixed_percent.clamp(MIN_FAN_PERCENT,100.0);
        self.fallback_percent=self.fallback_percent.clamp(80.0,100.0);
        self.sample_interval_ms=self.sample_interval_ms.clamp(1000,10000);
        self.smoothing_ms=self.smoothing_ms.min(60000);
        self.hysteresis_c=self.hysteresis_c.clamp(0.0,10.0);
        self.fall_delay_s=self.fall_delay_s.clamp(0.0,60.0);
        self.slew_up_percent_per_s=self.slew_up_percent_per_s.clamp(1.0,100.0);
        self.slew_down_percent_per_s=self.slew_down_percent_per_s.clamp(0.5,100.0);
        self.curve.sort();
        for p in &mut self.curve.points {p[1]=p[1].clamp(MIN_FAN_PERCENT,100.0);}
        self.curve.make_monotone();
    }
}
#[derive(Debug,Clone,Copy,Default)]
pub struct GroupInputs { pub cpu: Option<f32>,pub gpu: Option<f32>,pub coolant: Option<f32>,pub motherboard: Option<f32>,pub guard: bool }
#[derive(Debug,Clone,Default)]
pub struct GroupRuntime {
    policy: Option<FanGroupPolicy>, sampled_at: Option<f64>, filtered: Option<f32>,
    accepted: Option<f32>, output: Option<f32>, falling_since: Option<f64>,
}
#[derive(Debug,Clone)]
pub struct GroupOutput { pub percent: f32, pub source_error: Option<String> }
impl GroupRuntime {
    /// Inputs must be freshness-checked by the caller. None means unavailable, never 0°C.
    pub fn evaluate(&mut self,p: &FanGroupPolicy,i: GroupInputs,now_s:f64,dt:f32)->GroupOutput {
        if self.policy.as_ref()!=Some(p) {
            let source_changed=self.policy.as_ref().is_none_or(|old|old.source!=p.source);
            // Keep the actual output across edits: new settings still obey slew/fall delay.
            if source_changed {self.filtered=None;self.accepted=None;}
            self.sampled_at=None;
            self.policy=Some(p.clone());
        }
        let raw=match p.source { GroupSource::Cpu=>i.cpu,GroupSource::Gpu=>i.gpu,GroupSource::Coolant=>i.coolant }.filter(|v|v.is_finite());
        let mut error=None;
        let desired=match p.mode {
            CoolingMode::Fixed=>p.fixed_percent,
            CoolingMode::Motherboard=>i.motherboard.filter(|v|v.is_finite()).unwrap_or_else(||{error=Some("主板PWM不可用，保护转速生效".into());p.fallback_percent}),
            CoolingMode::Curve=>match raw {
                None=>{self.sampled_at=None;self.filtered=None;self.accepted=None;error=Some("温度源不可用，保护转速生效".into());p.fallback_percent},
                Some(t)=>{
                    if self.sampled_at.is_none_or(|s|now_s-s>=p.sample_interval_ms as f64/1000.0) {
                        let elapsed=self.sampled_at.map_or(dt,|s|(now_s-s) as f32).max(0.001);
                        let filtered=self.filtered.map_or(t,|prev|{
                            let tau=p.smoothing_ms as f32/1000.0;
                            prev+(t-prev)*if tau>0.0 {elapsed/(tau+elapsed)} else {1.0}
                        });
                        self.filtered=Some(filtered); self.sampled_at=Some(now_s);
                        if self.accepted.is_none_or(|old| (filtered-old).abs()>=p.hysteresis_c) {self.accepted=Some(filtered);}
                    }
                    p.curve.eval(self.accepted.unwrap_or(t)).unwrap_or(p.fallback_percent)
                }
            }
        }.clamp(MIN_FAN_PERCENT,100.0);
        let desired=if i.guard {desired.max(GUARD_FAN_PERCENT)} else {desired};
        let current=self.output.unwrap_or(desired);
        let next=if i.guard || (error.is_some() && desired>=current) { self.falling_since=None; desired.max(current) }
        else if desired < current {
            let since=*self.falling_since.get_or_insert(now_s);
            if now_s-since<f64::from(p.fall_delay_s) {current} else {(current-p.slew_down_percent_per_s*dt).max(desired)}
        } else {self.falling_since=None;(current+p.slew_up_percent_per_s*dt).min(desired)};
        self.output=Some(next);
        GroupOutput {percent:next,source_error:error}
    }
}

#[cfg(test)] mod tests {
    use super::*;
    fn p()->FanGroupPolicy {FanGroupPolicy{address:"aa:bb:cc:dd:ee:ff".into(),..Default::default()}}
    #[test] fn independent_fixed_groups() {let mut a=GroupRuntime::default();let mut b=GroupRuntime::default();let mut x=p();x.mode=CoolingMode::Fixed;x.fixed_percent=30.0;let mut y=x.clone();y.fixed_percent=70.0;assert_eq!(a.evaluate(&x,GroupInputs::default(),0.0,1.0).percent,30.0);assert_eq!(b.evaluate(&y,GroupInputs::default(),0.0,1.0).percent,70.0);}
    #[test] fn missing_source_is_safe_and_guard_overrides_fixed(){let mut r=GroupRuntime::default();let x=p();let o=r.evaluate(&x,GroupInputs::default(),0.0,1.0);assert!(o.percent>=80.0 && o.source_error.is_some());let mut x=p();x.mode=CoolingMode::Fixed;x.fixed_percent=20.0;assert!(r.evaluate(&x,GroupInputs{guard:true,..Default::default()},0.0,1.0).percent>=80.0);}
    #[test] fn reject_duplicate_and_nan_points(){let mut x=p();x.curve.points=vec![[40.0,30.0],[40.0,50.0]];assert!(x.validate().is_err());x.curve.points=vec![[f32::NAN,40.0]];assert!(x.validate().is_err());}
    #[test] fn editing_fixed_target_still_obeys_slew() {let mut r=GroupRuntime::default();let mut x=p();x.mode=CoolingMode::Fixed;x.fixed_percent=100.0;x.fall_delay_s=0.0;assert_eq!(r.evaluate(&x,GroupInputs::default(),0.0,1.0).percent,100.0);x.fixed_percent=30.0;assert_eq!(r.evaluate(&x,GroupInputs::default(),1.0,1.0).percent,95.0);}
    #[test] fn unavailable_source_can_slowly_settle_to_fallback() {let mut r=GroupRuntime::default();let mut x=p();x.fall_delay_s=0.0;let _=r.evaluate(&x,GroupInputs{cpu:Some(100.0),..Default::default()},0.0,1.0);assert_eq!(r.evaluate(&x,GroupInputs::default(),1.0,1.0).percent,95.0);}
    #[test] fn warm_cpu_without_coolant(){let mut r=GroupRuntime::default();let o=r.evaluate(&p(),GroupInputs{cpu:Some(70.0),..Default::default()},0.0,1.0);assert_eq!(o.percent,75.0);assert!(o.source_error.is_none());}
}
