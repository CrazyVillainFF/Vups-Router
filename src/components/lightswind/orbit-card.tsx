
import React from "react";

type OrbitCardProps = {
  children: React.ReactNode;
  className?: string;
};

const OrbitCard: React.FC<OrbitCardProps> = ({ children, className }) => {
  return (
    <div className={`relative ${className} rounded-xl`}>
      {/* Glowing shadow background */}
      <div className="absolute inset-0 z-0 flex items-center justify-center rounded-xl bg-background">
        <div className="absolute h-full w-full animate-orbit-glow rounded-xl">
          <div className="h-full w-full rounded-xl bg-transparent shadow-[0_0_30px_10px_rgba(59,130,246,0.5)]"></div>
        </div>
      </div>

      {/* Card Content */}
      <div className="relative z-10 rounded-xl bg-background p-6 ">
        {children}
      </div>

    </div>
  );
};

export default OrbitCard;
