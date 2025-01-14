import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedProcedure, publicProcedure } from "../trpc";
import {
  SaveCommentSchema,
  EditCommentSchema,
  DeleteCommentSchema,
  GetCommentsSchema,
  LikeCommentSchema,
} from "@/schema/comment";
import {
  NEW_COMMENT_ON_YOUR_POST,
  NEW_REPLY_TO_YOUR_COMMENT,
} from "@/utils/notifications";
import { comment, notification, like } from "@/server/db/schema";
import { and, eq } from "drizzle-orm";

export const commentRouter = createTRPCRouter({
  create: protectedProcedure
    .input(SaveCommentSchema)
    .mutation(async ({ input, ctx }) => {
      const { body, postId, parentId } = input;
      const userId = ctx.session.user.id;

      const postData = await ctx.db.query.post.findFirst({
        columns: { userId: true },
        where: (posts, { eq }) => eq(posts.id, postId),
      });

      const postOwnerId = postData?.userId;

      const [createdComment] = await ctx.db
        .insert(comment)
        .values({
          userId,
          postId,
          body,
          parentId,
        })
        .returning();

      if (parentId) {
        const commentData = await ctx.db.query.comment.findFirst({
          where: (posts, { eq }) => eq(posts.id, parentId),
          columns: { userId: true },
        });

        if (commentData?.userId && commentData?.userId !== userId) {
          await ctx.db.insert(notification).values({
            notifierId: userId,
            type: NEW_REPLY_TO_YOUR_COMMENT,
            postId,
            userId: commentData.userId,
            commentId: createdComment.id,
          });
        }
      }

      if (!parentId && postOwnerId && postOwnerId !== userId) {
        await ctx.db.insert(notification).values({
          notifierId: userId,
          type: NEW_COMMENT_ON_YOUR_POST,
          postId,
          userId: postOwnerId,
          commentId: createdComment.id,
        });
      }

      return createdComment.id;
    }),
  edit: protectedProcedure
    .input(EditCommentSchema)
    .mutation(async ({ input, ctx }) => {
      const { body, id } = input;

      const currentComment = await ctx.db.query.comment.findFirst({
        where: (comments, { eq }) => eq(comments.id, id),
      });

      if (currentComment?.userId !== ctx.session.user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
        });
      }

      if (currentComment.body === body) {
        return currentComment;
      }

      const updatedComment = await ctx.db
        .update(comment)
        .set({
          body,
        })
        .where(eq(comment.id, id));

      return updatedComment;
    }),
  delete: protectedProcedure
    .input(DeleteCommentSchema)
    .mutation(async ({ input, ctx }) => {
      const { id } = input;

      const currentComment = await ctx.db.query.comment.findFirst({
        where: (comments, { eq }) => eq(comments.id, id),
      });

      if (currentComment?.userId !== ctx.session.user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
        });
      }

      const [deletedComment] = await ctx.db
        .delete(comment)
        .where(eq(comment.id, id))
        .returning();

      return deletedComment.id;
    }),
  like: protectedProcedure
    .input(LikeCommentSchema)
    .mutation(async ({ input, ctx }) => {
      const { commentId } = input;
      const userId = ctx.session.user.id;

      const commentLiked = await ctx.db.query.like.findFirst({
        where: (likes, { eq }) =>
          and(eq(likes.userId, userId), eq(likes.commentId, commentId)),
      });

      const [res] = commentLiked
        ? await ctx.db
            .delete(like)
            .where(and(eq(like.userId, userId), eq(like.commentId, commentId)))
            .returning()
        : await ctx.db
            .insert(like)
            .values({
              commentId,
              userId,
            })
            .returning();

      return res;
    }),
  get: publicProcedure
    .input(GetCommentsSchema)
    .query(async ({ ctx, input }) => {
      const { postId } = input;
      const userId = ctx?.session?.user?.id;

      const SELECT_CHILD_CONFIG = {
        id: true,
        body: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            likes: true,
          },
        },
        user: {
          select: {
            name: true,
            image: true,
            username: true,
            id: true,
            email: true,
          },
        },
        likes: {
          where: {
            ...(userId ? { userId } : {}),
          },
          select: {
            userId: true,
          },
        },
      };

      const count = await ctx.prisma.comment.count({
        where: {
          postId,
        },
      });

      const response = await ctx.prisma.comment.findMany({
        where: {
          postId,
          parentId: null,
        },
        // Ugly as hell but this grabs comments up to 6 levels deep
        select: {
          ...SELECT_CHILD_CONFIG,
          children: {
            select: {
              ...SELECT_CHILD_CONFIG,
              children: {
                select: {
                  ...SELECT_CHILD_CONFIG,
                  children: {
                    select: {
                      ...SELECT_CHILD_CONFIG,
                      children: {
                        select: {
                          ...SELECT_CHILD_CONFIG,
                          children: {
                            select: {
                              ...SELECT_CHILD_CONFIG,
                              children: {
                                select: { ...SELECT_CHILD_CONFIG },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: {
          createdAt: "desc",
        },
      });
      interface ShapedResponse {
        user: {
          id: string;
          username: string | null;
          name: string;
          image: string;
          email: string | null;
        };
        youLikedThis: boolean;
        likeCount: number;
        id: number;
        body: string;
        createdAt: Date;
        updatedAt: Date;
        children?: ShapedResponse[];
      }
      [];

      function shapeComments(commentsArr: typeof response): ShapedResponse[] {
        const value = commentsArr.map((comment) => {
          const {
            children,
            likes: youLikeThis,
            _count: likeCount,
            ...rest
          } = comment;

          const shaped = {
            youLikedThis: youLikeThis.some((obj) => obj.userId === userId),
            likeCount: likeCount.likes,
            ...rest,
          };
          if (children) {
            return {
              ...shaped,
              children: shapeComments(children),
            };
          }
          return shaped;
        });
        return value;
      }

      const comments = shapeComments(response);

      return { data: comments, count };
    }),
});
