import { Button } from './ui/button';
import { Share2, Loader2 } from 'lucide-react';
import { useWebShare } from '@/hooks/useWebShare';
import { toast } from 'sonner';

interface ShareButtonProps {
  title?: string;
  text?: string;
  url?: string;
  variant?: 'default' | 'outline' | 'ghost' | 'secondary';
  size?: 'default' | 'sm' | 'lg' | 'icon';
  className?: string;
  showIcon?: boolean;
  showText?: boolean;
}

export function ShareButton({
  title,
  text,
  url,
  variant = 'outline',
  size = 'default',
  className,
  showIcon = true,
  showText = true,
}: ShareButtonProps) {
  const { isSupported, isSharing, share } = useWebShare();

  const handleShare = async () => {
    const success = await share({ title, text, url });
    if (success) {
      toast.success('Shared successfully');
    }
  };

  // Don't render if not supported
  if (!isSupported) {
    return null;
  }

  return (
    <Button
      variant={variant}
      size={size}
      onClick={handleShare}
      disabled={isSharing}
      className={className}
    >
      {isSharing ? (
        <>
          {showIcon && <Loader2 className="h-4 w-4 animate-spin" />}
          {showText && size !== 'icon' && <span className={showIcon ? 'ml-2' : ''}>Sharing...</span>}
        </>
      ) : (
        <>
          {showIcon && <Share2 className="h-4 w-4" />}
          {showText && size !== 'icon' && <span className={showIcon ? 'ml-2' : ''}>Share</span>}
        </>
      )}
    </Button>
  );
}
