import accountant from "@/assets/brand/bao-presets/accountant.png";
import actor from "@/assets/brand/bao-presets/actor.png";
import adSpecialist from "@/assets/brand/bao-presets/ad-specialist.png";
import adminSpecialist from "@/assets/brand/bao-presets/admin-specialist.png";
import automationEngineer from "@/assets/brand/bao-presets/automation-engineer.png";
import brandPlanner from "@/assets/brand/bao-presets/brand-planner.png";
import businessDevelopment from "@/assets/brand/bao-presets/business-development.png";
import chef from "@/assets/brand/bao-presets/chef.png";
import constructionEngineer from "@/assets/brand/bao-presets/construction-engineer.png";
import copywriter from "@/assets/brand/bao-presets/copywriter.png";
import courier from "@/assets/brand/bao-presets/courier.png";
import creativeDesigner from "@/assets/brand/bao-presets/creative-designer.png";
import customerServiceManager from "@/assets/brand/bao-presets/customer-service-manager.png";
import customerSuccess from "@/assets/brand/bao-presets/customer-success.png";
import dataAnalyst from "@/assets/brand/bao-presets/data-analyst.png";
import designer from "@/assets/brand/bao-presets/designer.png";
import director from "@/assets/brand/bao-presets/director.png";
import doctor from "@/assets/brand/bao-presets/doctor.png";
import farmer from "@/assets/brand/bao-presets/farmer.png";
import financialAdvisor from "@/assets/brand/bao-presets/financial-advisor.png";
import firefighter from "@/assets/brand/bao-presets/firefighter.png";
import fitnessCoach from "@/assets/brand/bao-presets/fitness-coach.png";
import founderAssistant from "@/assets/brand/bao-presets/founder-assistant.png";
import generalManager from "@/assets/brand/bao-presets/general-manager.png";
import hrManager from "@/assets/brand/bao-presets/hr-manager.png";
import journalist from "@/assets/brand/bao-presets/journalist.png";
import lawyer from "@/assets/brand/bao-presets/lawyer.png";
import legalAdvisor from "@/assets/brand/bao-presets/legal-advisor.png";
import liveStreamOperator from "@/assets/brand/bao-presets/live-stream-operator.png";
import marketingDirector from "@/assets/brand/bao-presets/marketing-director.png";
import operationsDirector from "@/assets/brand/bao-presets/operations-director.png";
import pilot from "@/assets/brand/bao-presets/pilot.png";
import privateDomainOperator from "@/assets/brand/bao-presets/private-domain-operator.png";
import productManager from "@/assets/brand/bao-presets/product-manager.png";
import programmer from "@/assets/brand/bao-presets/programmer.png";
import projectManager from "@/assets/brand/bao-presets/project-manager.png";
import salesConsultant from "@/assets/brand/bao-presets/sales-consultant.png";
import securityOfficer from "@/assets/brand/bao-presets/security-officer.png";
import singer from "@/assets/brand/bao-presets/singer.png";
import socialMediaOperator from "@/assets/brand/bao-presets/social-media-operator.png";
import storeManager from "@/assets/brand/bao-presets/store-manager.png";
import teacher from "@/assets/brand/bao-presets/teacher.png";
import techEngineer from "@/assets/brand/bao-presets/tech-engineer.png";
import testEngineer from "@/assets/brand/bao-presets/test-engineer.png";
import tourGuide from "@/assets/brand/bao-presets/tour-guide.png";
import cool from "@/assets/brand/xiongbao-cool.png";
import cute from "@/assets/brand/xiongbao-cute.png";
import happy from "@/assets/brand/xiongbao-happy.png";
import naughty from "@/assets/brand/xiongbao-naughty.png";
import sweet from "@/assets/brand/xiongbao-sweet.png";
import type { PortraitPreset } from "@/lib/portraits/queries";

/** The five expressions on the brand's character sheet (表情特写) plus the 45 role faces
 * (第二批), each cut to a round portrait. */
export const PRESET_IMAGES: Record<PortraitPreset, string> = {
  naughty,
  cute,
  cool,
  happy,
  sweet,
  doctor,
  teacher,
  chef,
  "tech-engineer": techEngineer,
  "financial-advisor": financialAdvisor,
  lawyer,
  "construction-engineer": constructionEngineer,
  farmer,
  courier,
  pilot,
  firefighter,
  "tour-guide": tourGuide,
  journalist,
  "creative-designer": creativeDesigner,
  "fitness-coach": fitnessCoach,
  "general-manager": generalManager,
  accountant,
  "operations-director": operationsDirector,
  designer,
  director,
  programmer,
  "social-media-operator": socialMediaOperator,
  actor,
  singer,
  "product-manager": productManager,
  "data-analyst": dataAnalyst,
  "marketing-director": marketingDirector,
  "hr-manager": hrManager,
  "legal-advisor": legalAdvisor,
  "customer-service-manager": customerServiceManager,
  "founder-assistant": founderAssistant,
  "project-manager": projectManager,
  "admin-specialist": adminSpecialist,
  "sales-consultant": salesConsultant,
  "business-development": businessDevelopment,
  "customer-success": customerSuccess,
  copywriter,
  "brand-planner": brandPlanner,
  "ad-specialist": adSpecialist,
  "store-manager": storeManager,
  "live-stream-operator": liveStreamOperator,
  "private-domain-operator": privateDomainOperator,
  "automation-engineer": automationEngineer,
  "test-engineer": testEngineer,
  "security-officer": securityOfficer,
};
