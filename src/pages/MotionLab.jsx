import React, { useRef } from "react";
import { Link } from "react-router-dom";
import ArrowOutwardRoundedIcon from "@mui/icons-material/ArrowOutwardRounded";
import NorthEastRoundedIcon from "@mui/icons-material/NorthEastRounded";
import SiteHeader from "../components/SiteHeader.jsx";
import SiteFooter from "../components/SiteFooter.jsx";
import PageMeta from "../components/PageMeta.jsx";
import VupsLogo from "../components/VupsLogo.jsx";

import SplitText from "../components/reactbits/SplitText/SplitText.jsx";
import BlurText from "../components/reactbits/BlurText/BlurText.jsx";
import ShinyText from "../components/reactbits/ShinyText/ShinyText.jsx";
import GradientText from "../components/reactbits/GradientText/GradientText.jsx";
import DecryptedText from "../components/reactbits/DecryptedText/DecryptedText.jsx";
import RotatingText from "../components/reactbits/RotatingText/RotatingText.jsx";
import CountUp from "../components/reactbits/CountUp/CountUp.jsx";
import ScrambledText from "../components/reactbits/ScrambledText/ScrambledText.jsx";
import Shuffle from "../components/reactbits/Shuffle/Shuffle.jsx";
import TextType from "../components/reactbits/TextType/TextType.jsx";
import TextPressure from "../components/reactbits/TextPressure/TextPressure.jsx";
import VariableProximity from "../components/reactbits/VariableProximity/VariableProximity.jsx";
import CircularText from "../components/reactbits/CircularText/CircularText.jsx";
import ScrollFloat from "../components/reactbits/ScrollFloat/ScrollFloat.jsx";
import ScrollVelocity from "../components/reactbits/ScrollVelocity/ScrollVelocity.jsx";
import SpotlightCard from "../components/reactbits/SpotlightCard/SpotlightCard.jsx";
import StarBorder from "../components/reactbits/StarBorder/StarBorder.jsx";
import Magnet from "../components/reactbits/Magnet/Magnet.jsx";
import ClickSpark from "../components/reactbits/ClickSpark/ClickSpark.jsx";
import GlareHover from "../components/reactbits/GlareHover/GlareHover.jsx";
import ElectricBorder from "../components/reactbits/ElectricBorder/ElectricBorder.jsx";
import TiltedCard from "../components/reactbits/TiltedCard/TiltedCard.jsx";
import PixelTrail from "../components/reactbits/PixelTrail/PixelTrail.jsx";
import GradualBlur from "../components/reactbits/GradualBlur/GradualBlur.jsx";
import Stack from "../components/reactbits/Stack/Stack.jsx";
import AnimatedContent from "../components/reactbits/AnimatedContent/AnimatedContent.jsx";
import FadeContent from "../components/reactbits/FadeContent/FadeContent.jsx";
import LogoLoop from "../components/reactbits/LogoLoop/LogoLoop.jsx";

import "./motion-lab.css";

const stackCards = [
  <div className="ml-stack-face" key="galax">
    <span>VUPS V3</span>
    <strong>Galax</strong>
  </div>,
  <div className="ml-stack-face ml-stack-face--alt" key="general">
    <span>MODE</span>
    <strong>General</strong>
  </div>,
  <div className="ml-stack-face ml-stack-face--deep" key="motion">
    <span>MODE</span>
    <strong>Motion</strong>
  </div>,
  <div className="ml-stack-face ml-stack-face--line" key="route">
    <span>ROUTE</span>
    <strong>Your key</strong>
  </div>
];

const modelLogos = [
  { node: <span className="ml-logo-node">Vups v3 Galax</span>, ariaLabel: "Vups v3 Galax" },
  { node: <span className="ml-logo-node">OpenAI-compatible</span>, ariaLabel: "OpenAI-compatible" },
  { node: <span className="ml-logo-node">Anthropic</span>, ariaLabel: "Anthropic" },
  { node: <span className="ml-logo-node">Gemini</span>, ariaLabel: "Gemini" },
  { node: <span className="ml-logo-node">Azure</span>, ariaLabel: "Azure" },
  { node: <span className="ml-logo-node">Your route</span>, ariaLabel: "Your route" }
];

function DemoCard({ number, name, note, wide = false, className = "", stageClassName = "", children }) {
  return (
    <article className={`ml-demo${wide ? " ml-demo--wide" : ""}${className ? ` ${className}` : ""}`}>
      <header className="ml-demo-head">
        <span className="ml-demo-number">{number}</span>
        <div>
          <h3>{name}</h3>
          <p>{note}</p>
        </div>
      </header>
      <div className={`ml-stage${stageClassName ? ` ${stageClassName}` : ""}`}>{children}</div>
    </article>
  );
}

function ProximityDemo() {
  const areaRef = useRef(null);
  return (
    <div ref={areaRef} className="ml-stage ml-stage--proximity">
      <VariableProximity
        label="Move across the route"
        containerRef={areaRef}
        radius={180}
        falloff="gaussian"
        fromFontVariationSettings="'wght' 300"
        toFontVariationSettings="'wght' 900"
        fromColor="#71819a"
        toColor="#6c9bff"
        className="ml-varprox"
        fontSize="clamp(1.4rem, 3.2vw, 2.1rem)"
      />
    </div>
  );
}

export default function MotionLabPage() {
  return (
    <>
      <PageMeta
        title="Motion Lab — VupsRouter"
        description="A live React Bits motion lab built into VupsRouter: 28 animated text, surface, and scroll components tuned to the navy and cobalt system."
      />
      <SiteHeader />
      <main id="main-content" className="ml-page">
        <div className="ml-aura" aria-hidden="true" />
        <section className="ml-hero">
          <div className="ml-hero-copy">
            <div className="ml-eyebrow">
              <span className="ml-eyebrow-line" />
              <ShinyText
                text="MOTION LAB / 28 COMPONENTS"
                color="#8fa1bb"
                shineColor="#e9eef7"
                speed={2.6}
                shineWidth={38}
              />
            </div>
            <SplitText
              tag="h1"
              text="Motion, on every route."
              className="ml-hero-title"
              effect="wave"
              splitType="chars"
              delay={26}
              duration={1.15}
              textAlign="left"
              color="#e9eef7"
            />
            <BlurText
              text="A live collection of React Bits text, surface, and scroll components, restyled to the VupsRouter navy and cobalt system. Every piece below is running in this page."
              className="ml-hero-description"
              animateBy="words"
              delay={28}
              stepDuration={0.3}
            />
            <div className="ml-hero-actions">
              <Magnet padding={70} magnetStrength={2.6}>
                <StarBorder
                  as={Link}
                  to="/chat"
                  className="ml-hero-cta"
                  color="#6c9bff"
                  trailColor="#a9c2ff"
                  theme="dark"
                  duration={5}
                  thickness={1.2}
                  radius={999}
                  backgroundColor="#0b1322"
                  textColor="#e9eef7"
                >
                  Open AI chat <ArrowOutwardRoundedIcon fontSize="small" />
                </StarBorder>
              </Magnet>
              <Link className="ml-text-link" to="/">
                Back to VupsRouter <NorthEastRoundedIcon fontSize="small" />
              </Link>
            </div>
            <div className="ml-hero-stats">
              <span className="ml-stat">
                <CountUp to={28} duration={1.5} className="ml-stat-value" />
                <small>live components</small>
              </span>
              <span className="ml-stat">
                <CountUp to={3} duration={1.2} className="ml-stat-value" />
                <small>runtime libraries</small>
              </span>
              <span className="ml-stat">
                <CountUp to={1} duration={1} className="ml-stat-value" />
                <small>design system</small>
              </span>
            </div>
          </div>
          <div className="ml-hero-orbit">
            <CircularText
              text="VUPSROUTER • MOTION LAB • "
              size={250}
              fontSize={13}
              fontWeight={600}
              spinDuration={26}
              onHover="speedUp"
              ring
              ringColor="rgba(108,155,255,.28)"
              className="ml-orbit-text"
            >
              <span className="ml-orbit-logo">
                <VupsLogo sizes="92px" />
              </span>
            </CircularText>
            <span className="ml-orbit-caption">GENERAL / MOTION / YOUR KEYS</span>
          </div>
        </section>

        <div className="ml-velocity-band">
          <ScrollVelocity
            texts={["VUPSROUTER / MOTION LAB / 28 COMPONENTS / "]}
            velocity={70}
            numCopies={5}
            className="ml-velocity"
            fontSize="clamp(1.1rem, 2.4vw, 1.6rem)"
            fontWeight={500}
            color="#6c9bff"
            fadeEdges
          />
        </div>

        <section className="ml-section" aria-labelledby="ml-type-title">
          <div className="ml-section-head">
            <div>
              <span className="ml-kicker">01 / TYPE SYSTEMS</span>
              <h2 id="ml-type-title">Words in motion.</h2>
            </div>
            <p>Staggered glyphs, blur pulls, rotating routes, and variable-weight type. Hover or scroll the cards to replay.</p>
          </div>
          <div className="ml-grid">
            <DemoCard number="01" name="SplitText" note="GSAP character stagger" wide>
              <SplitText
                text="Route every word."
                className="ml-split-demo"
                effect="wave"
                splitType="chars"
                delay={22}
                duration={0.9}
                textAlign="left"
                color="#e9eef7"
              />
            </DemoCard>
            <DemoCard number="02" name="BlurText" note="Word-by-word focus pull">
              <BlurText text="Clarity arrives in motion." animateBy="words" delay={40} className="ml-demo-copy" />
            </DemoCard>
            <DemoCard number="03" name="ShinyText" note="Sweeping light across type">
              <ShinyText
                text="Premium by default."
                color="#8fa1bb"
                shineColor="#e9eef7"
                speed={2.2}
                shineWidth={46}
                className="ml-demo-copy ml-shiny"
              />
            </DemoCard>
            <DemoCard number="04" name="GradientText" note="Animated cobalt gradient">
              <GradientText
                colors={["#6c9bff", "#dbe6ff", "#3f6fe8"]}
                animationSpeed={7}
                yoyo
                className="ml-gradient"
              >
                Cobalt current
              </GradientText>
            </DemoCard>
            <DemoCard number="05" name="DecryptedText" note="Scramble on view or hover">
              <DecryptedText
                text="ROUTE / DECRYPTED"
                animateOn="view"
                speed={24}
                maxIterations={14}
                className="ml-mono-text"
              />
            </DemoCard>
            <DemoCard number="06" name="RotatingText" note="Spring-rotating answers">
              <div className="ml-rotating">
                <span>Route to</span>
                <RotatingText
                  texts={["Galax", "your model", "the right fit"]}
                  rotationInterval={1900}
                  mainClassName="ml-rotating-pill"
                  splitLevelClassName="ml-rotating-level"
                />
              </div>
            </DemoCard>
            <DemoCard number="07" name="CountUp" note="Slot-rolling numbers">
              <CountUp to={28} suffix=" components" duration={1.7} className="ml-count" />
            </DemoCard>
            <DemoCard number="08" name="ScrambledText" note="Hover-radius scramble">
              <ScrambledText
                className="ml-scramble"
                radius={150}
                duration={1}
                scrambleChars=".:/"
                effect="scramble"
              >
                Hover to scramble the route.
              </ScrambledText>
            </DemoCard>
            <DemoCard number="09" name="Shuffle" note="Character shuffle on hover">
              <Shuffle
                text="VUPSROUTER"
                tag="p"
                effect="slide"
                duration={0.5}
                stagger={0.02}
                className="ml-shuffle"
              />
            </DemoCard>
            <DemoCard number="10" name="TextType" note="Typed copy with a cursor">
              <TextType
                text={["One chat. More ways to build."]}
                typingSpeed={45}
                initialDelay={250}
                loop={false}
                showCursor
                cursorCharacter="▌"
                cursorColor="#6c9bff"
                className="ml-type"
              />
            </DemoCard>
            <DemoCard number="11" name="TextPressure" note="Variable font under pressure">
              <TextPressure
                text="GALAX"
                fontFamily="Roboto Flex"
                minFontSize={30}
                textColor="#e9eef7"
                pressureColor="#6c9bff"
                className="ml-pressure"
              />
            </DemoCard>
            <DemoCard number="12" name="VariableProximity" note="Pointer-reactive weight">
              <ProximityDemo />
            </DemoCard>
            <DemoCard number="13" name="CircularText" note="Orbiting type" wide>
              <CircularText
                text="VUPSROUTER • MOTION LAB • "
                size={190}
                fontSize={12}
                fontWeight={600}
                spinDuration={20}
                ring
                ringColor="rgba(108,155,255,.3)"
                className="ml-orbit-text"
              >
                <span className="ml-circular-core">V3</span>
              </CircularText>
            </DemoCard>
          </div>
        </section>

        <section className="ml-section" aria-labelledby="ml-surface-title">
          <div className="ml-section-head">
            <div>
              <span className="ml-kicker">02 / SURFACES + INTERACTION</span>
              <h2 id="ml-surface-title">Surfaces with current.</h2>
            </div>
            <p>Cursor light, magnetic pull, electric edges, and canvas trails contained inside the same dark material language.</p>
          </div>
          <div className="ml-grid">
            <DemoCard number="14" name="SpotlightCard" note="Cursor-led spotlight">
              <SpotlightCard
                className="ml-spotlight"
                spotlightColor="rgba(108,155,255,.5)"
                intensity={0.22}
                spotlightSize={220}
                style={{
                  "--spotlight-card-surface": "#0c1626",
                  "--spotlight-card-border": "rgba(108,155,255,.26)",
                  "--spotlight-card-shadow": "0 24px 48px -24px rgba(2,6,16,.75)"
                }}
              >
                <span className="ml-demo-kicker">SPOTLIGHT / CARD</span>
                <strong>Light follows the route.</strong>
              </SpotlightCard>
            </DemoCard>
            <DemoCard number="15" name="StarBorder" note="Orbiting border light">
              <StarBorder
                as={Link}
                to="/chat"
                className="ml-star"
                color="#6c9bff"
                trailColor="#a9c2ff"
                theme="dark"
                duration={4.5}
                radius={999}
                backgroundColor="#0b1322"
                textColor="#e9eef7"
              >
                Open AI chat
              </StarBorder>
            </DemoCard>
            <DemoCard number="16" name="Magnet" note="Spring magnetic pull">
              <Magnet padding={90} magnetStrength={3} maxOffset={40}>
                <span className="ml-magnet-btn">Magnetic pull</span>
              </Magnet>
            </DemoCard>
            <DemoCard number="17" name="ClickSpark" note="Click to emit sparks">
              <ClickSpark
                sparkColor="#6c9bff"
                sparkSize={12}
                sparkCount={12}
                sparkRadius={36}
                duration={600}
                glow={0.5}
                className="ml-spark"
              >
                <div className="ml-spark-inner">Click anywhere</div>
              </ClickSpark>
            </DemoCard>
            <DemoCard number="18" name="GlareHover" note="Hover glare sweep">
              <GlareHover
                className="ml-glare"
                width="100%"
                height="160px"
                background="linear-gradient(135deg,#101c33,#0b1322)"
                borderRadius="16px"
                borderColor="rgba(148,163,184,.22)"
                glareColor="#a9c2ff"
                glareOpacity={0.6}
                mode="hover"
              >
                <span className="ml-glare-label">Glide to reveal</span>
              </GlareHover>
            </DemoCard>
            <DemoCard number="19" name="ElectricBorder" note="Charged canvas border">
              <ElectricBorder
                color="#6c9bff"
                glowColor="#6c9bff"
                borderRadius={16}
                speed={0.9}
                chaos={0.4}
                className="ml-electric"
              >
                <div className="ml-electric-inner">Charged surface</div>
              </ElectricBorder>
            </DemoCard>
            <DemoCard number="20" name="TiltedCard" note="3D tilt with the logo">
              <TiltedCard
                imageSrc="/vups-logo.png"
                altText="VupsRouter logo"
                captionText="VupsRouter"
                containerHeight="190px"
                imageHeight="150px"
                imageWidth="150px"
                rotateAmplitude={14}
                scaleOnHover={1.08}
              />
            </DemoCard>
            <DemoCard number="21" name="PixelTrail" note="Canvas pixel trail" wide>
              <div className="ml-pixel">
                <PixelTrail
                  gridSize={24}
                  color="#6c9bff"
                  trailSize={0.22}
                  maxAge={600}
                  gap={0.1}
                  decay="fade"
                  clickBurst
                  shine={0.7}
                  glow={0.5}
                />
                <span className="ml-pixel-label">TRACE THE ROUTE</span>
              </div>
            </DemoCard>
            <DemoCard number="22" name="GradualBlur" note="Layered edge blur">
              <div className="ml-blur-stage">
                <span className="ml-blur-content">EDGE / FOCUS</span>
                <GradualBlur
                  target="parent"
                  position="bottom"
                  height="4.5rem"
                  strength={2.2}
                  layers={6}
                  tint="#070b14"
                />
              </div>
            </DemoCard>
            <DemoCard number="23" name="Stack" note="Drag the model stack" wide>
              <Stack
                cards={stackCards}
                visible={3}
                spread={0.42}
                tilt={18}
                autoplay
                autoplayDelay={2800}
                pauseOnHover
                className="ml-stack"
              />
            </DemoCard>
          </div>
        </section>

        <section className="ml-section" aria-labelledby="ml-scroll-title">
          <div className="ml-section-head">
            <div>
              <span className="ml-kicker">03 / REVEALS + SCROLL</span>
              <h2 id="ml-scroll-title">Reveal on the route.</h2>
            </div>
            <p>Scroll-linked entrances and velocity strips. These run against the page scroll, not a fixed timeline.</p>
          </div>
          <div className="ml-grid">
            <DemoCard number="24" name="AnimatedContent" note="Scroll-triggered entrance">
              <AnimatedContent distance={40} duration={0.7} blur={2} className="ml-reveal-card">
                <span className="ml-demo-kicker">ANIMATED CONTENT</span>
                <strong>Distance, blur, and scale in one reveal.</strong>
              </AnimatedContent>
            </DemoCard>
            <DemoCard number="25" name="FadeContent" note="Soft fade with blur">
              <FadeContent blur duration={0.9} className="ml-reveal-card">
                <span className="ml-demo-kicker">FADE CONTENT</span>
                <strong>A quiet entrance for dense surfaces.</strong>
              </FadeContent>
            </DemoCard>
            <DemoCard number="26" name="ScrollFloat" note="Scroll-linked float" wide>
              <ScrollFloat
                textClassName="ml-scrollfloat-demo-text"
                stagger={0.03}
                distance={70}
                animationDuration={0.7}
              >
                Scroll with the current.
              </ScrollFloat>
            </DemoCard>
            <DemoCard number="27" name="ScrollVelocity" note="Velocity-reactive marquee" wide>
              <ScrollVelocity
                texts={["VUPSROUTER / MOTION LAB / "]}
                velocity={55}
                numCopies={4}
                className="ml-velocity-demo"
                fontSize="clamp(1.5rem, 3vw, 2.25rem)"
                fontWeight={600}
                color="#6c9bff"
                fadeEdges
              />
            </DemoCard>
            <DemoCard number="28" name="LogoLoop" note="Draggable model loop" wide stageClassName="ml-stage--logo">
              <LogoLoop
                logos={modelLogos}
                speed={90}
                logoHeight={38}
                gap={18}
                pauseOnHover
                fadeOut
                draggable
                ariaLabel="Supported model routes"
                className="ml-logoloop"
              />
            </DemoCard>
          </div>
        </section>

        <section className="ml-outro">
          <div className="ml-outro-copy">
            <span className="ml-kicker">BUILT INTO VUPSROUTER</span>
            <h2>
              One system.
              <br />
              <GradientText colors={["#6c9bff", "#dbe6ff", "#3f6fe8"]} animationSpeed={8} className="ml-outro-gradient">
                Every route in motion.
              </GradientText>
            </h2>
            <p>All 28 components run locally from the official React Bits sources, behind a lazy-loaded route so the chat surface stays fast.</p>
          </div>
          <Magnet padding={60} magnetStrength={2.2}>
            <StarBorder
              as={Link}
              to="/chat"
              className="ml-outro-cta"
              color="#6c9bff"
              trailColor="#a9c2ff"
              theme="dark"
              radius={999}
              backgroundColor="#0b1322"
              textColor="#e9eef7"
            >
              Start a chat <ArrowOutwardRoundedIcon fontSize="small" />
            </StarBorder>
          </Magnet>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
